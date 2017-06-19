
const fs = require('fs');
const path = require('path');
const https = require('https');
const express = require('express');
const sqlite3 = require('sqlite3');
const Promise = require('bluebird');
const kaltura = require('kaltura-client');
const {WebRtcServer, RtspServer, ffmpeg} = require('mediasoup-server');

const recordingsPath = path.join(__dirname, "recordings");

const kalturaConfig = require('./config/kaltura.js');

const streamer = new ffmpeg({
	enableDebug: true
});

class Recording {
	constructor(id, rtspUrl, filepath, logpath) {
		this.id = id;
		this.filepath = filepath;
		this.ready = false;
		this.closed = false;
		this.callback = null;
		
		let d = new Date();
		this.time = d.getTime();
		
		streamer.record(rtspUrl, filepath, logpath)
		.on('error', (err) => {
			console.error(`Streamer [${id}] error: ${err}`);
		})
		.on('exit', (code, signal) => {
			console.log(`Streamer [${id}] closed, log: ${logpath}`);
			this.done();
		});
	}
	
	isOld() {
		let d = new Date();
		return (d.getTime() - this.time) > 300000; // five minutes ago
	}
	
	done() {
		this.ready = true;
		this.close();
	}
	
	close() {
		if(this.ready && this.callback) {
			this.callback(this.filepath);
			this.closed = true;
		}
	}
	
	onReady(callback) {
		this.callback = callback;
		this.close();
	}
}

class Server {

	constructor() {
		this.db = new sqlite3.Database('./db/db.sqlite');

        let config = new kaltura.Configuration();
        if(kalturaConfig.serviceUrl) {
            config.serviceUrl = kalturaConfig.serviceUrl;
        }
        this.client = new kaltura.Client(config);
        this.startSession();

		this.recordings = {};
		setInterval(() => {
			this.cleanup();
		}, 300000); // every 5 minutes
	}
    
    cleanup() {
		for(let recordingId in this.recordings) {
			let recording = this.recordings[recordingId];
			if(typeof(recording) == 'object' && (recording.closed || recording.isOld())) {
				delete this.recordings[recordingId];
			}
		}
		
		let d = new Date();
		let deprecatedTime = d.getTime() - (1000 * 60 * 60 * 12); // 12 hours ago
		let sql = `DELETE FROM markers WHERE createdAt < ${deprecatedTime}`;
		this.db.run(sql, (err) => {
			if(err) {
				console.error(err);
			}
		});
	}
    
    startSession() {
		let userId = null;
		let type = kaltura.enums.SessionType.USER;
		let expiry = null;
		let privileges = null;
		
		kaltura.services.session.start(kalturaConfig.secret, userId, type, kalturaConfig.partnerId, expiry, privileges)
    	.completion((success, ks) => {
    		if(success) {
    			this.client.setKs(ks);
    		}
    		else {
    			console.error(ks.message);
    		}
    	})
    	.execute(this.client);
    }
	
    listen(port) {
        const options = {
        	key: fs.readFileSync('keys/server.key'),
        	cert: fs.readFileSync('keys/server.crt'),
        };

		const app = express();
		app.use(express.static('./public'));
		app.post(/.*\.json$/, (request, response) => {
			this.json(request)
	        .then((content) => {
	        	response.send(content);
	        }, (err) => {
	            response.writeHead(500);
	            response.end(`Sorry, check with the site admin for error: ${err}`);
	            response.end();
	        });
		});
		
        const webServer = https.createServer(options, app)
        .listen(port);

        const webRtcServer = new WebRtcServer()
        .setWebServer(webServer)
        .listen({
        	enableDebug: true
        })
        .on('listen', () => {
        	console.log('Mediasoup server started');
        })
        .on('new-connection', (connection) => {
        	console.log(`New connection [${connection.id}]`);
        	
        	connection
        	.on('error', (err) => {
        		console.error(`Connection [${connection.id}] error: ${err}`);
        	})
        	.on('receive', (action, data) => {
        		console.log(`Connection [${connection.id}] receive [${action}]`, data);
        	})
        	.on('send', (action, data) => {
        		console.log(`Connection [${connection.id}] send [${action}]`, data);
        	})
        	.on('new-stream', (stream) => {
        		console.log(`Connection [${connection.id}] peer [${stream.peer.id}] new stream [${stream.id}]`, stream.rtpParameters);
        	})
        	.on('ready', (peerConnection) => {
        		console.log(`Connection [${connection.id}] peer [${peerConnection.peer.id}] ready (${peerConnection.peer.rtpReceivers.length} streams)`);
        	})
        	.on('close', (peerId) => {
        		console.log(`Connection [${connection.id}] peer [${peerId}] closed`);
        	})
        	.on('disconnect', (err) => {
        		console.log(`Connection [${connection.id}] signaling disconnected`);
        		connection = null;
        	});
        });

        this.rtspServer = new RtspServer(webRtcServer);
        this.rtspServer
        .listen(5000)
        .on('new-source', (source) => {
        	source.on('enabled', () => {
    			this.record(source.id);
    			source.connection.socket.emit('recording', source.id);
        	});
        })
        .on('request', (method, uri) => {
        	console.log(`RTSP [${method}] ${uri}`);
        });
    }

    record(sourceId) {
		console.log(`Source [${sourceId}] recording`);

    	let rtspUrl = `rtsp://127.0.0.1:${this.rtspServer.port}/${sourceId}.sdp`;
		let filepath = `${recordingsPath}/${sourceId}.mp4`;
		let logpath = `${recordingsPath}/${sourceId}.log`;
		
		this.recordings[sourceId] = new Recording(sourceId, rtspUrl, filepath, logpath);
    }

    json(request) {
        let filePath = request.url;
        let method = path.basename(filePath, '.json');
        
        return new Promise((resolve, reject) => {

            if (!this[method] || typeof (this[method]) !== 'function') {
            	return resolve(null);
            }
            	
            var body = '';
            request.on('data', (data) => {
                body += data;
            });
            request.on('end', () => {
                var data = body.length ? JSON.parse(body) : null;
                this[method](data)
            	.then((data) => {
                    resolve(JSON.stringify(data));
            	})
            	.catch((err) => {
            		reject(err);
            	});
            });
        });
    }

    markers(bounds) {
    	let {south, west, north, east} = bounds;

        return new Promise((resolve, reject) => {
        	this.db.all('SELECT * FROM markers', (err, rows) => {
				if(err) {
					reject(err);
				}
				else {
					resolve(rows.map((row) => this.db2marker(row)));
				}
			});
        });
    }
    
    db2marker(row) {
    	return {
            position : {
            	lat: row.lat, 
            	lng: row.lng
            },
            id : row.id,
            title : row.title,
            description : row.description,
            entryId : row.entryId,
            createdAt : row.createdAt
        };
    }
    
    escapeString(str) {
    	return str.replace('"', '\\"');
    }
    
    addMarkerToDB(marker, entryId = null) {
        return new Promise((resolve, reject) => {
        	let d = new Date();
        	let createdAt = d.getTime();
        	let This = this;
        	
        	let sql = 'INSERT INTO markers (title, description, entryId, createdAt, lat, lng) VALUES (?, ?, ?, ?, ?, ?)';
        	this.db.run(sql, [marker.title, marker.description, entryId, createdAt, marker.position.lat, marker.position.lng], function(err) {
    			if(err) {
    				return reject(err);
    			}
    
    			let lastID = this.lastID;
    			This.db.get(`SELECT * FROM markers WHERE id = ${lastID}`, (err, row) => {
    				if(err) {
    					reject(err);
    				}
    				else {
    					resolve(This.db2marker(row));
    				}
    			});
    		});
        });
    }
    
    uploadEntry(entryId, recordingId) {
    	console.log(`Uploading ${recordingId}`, typeof(this.recordings[recordingId]), this.recordings[recordingId]);
    	let recording = this.recordings[recordingId];
    	recording.onReady((filepath) => {
    		fs.stat(filepath, (err, stats) => {
            	let uploadToken = new kaltura.objects.UploadToken({
            		fileName: path.basename(filepath),
            		fileSize: stats.size
            	});
            	let contentResource = new kaltura.objects.UploadedFileTokenResource({
            		token: '{1:result:id}'
            	});
            	
            	let multiRequest = kaltura.services.uploadToken.add(uploadToken)
        		.add(kaltura.services.media.addContent(entryId, contentResource))
        		.add(kaltura.services.uploadToken.upload('{1:result:id}', filepath));

            	multiRequest
        		.execute(this.client, (success, results) => {
        			if(results.message) { // general transport error
        				console.error(results.message);
        				return;
        			}

        			for(var i = 0; i < results.length; i++){
        				if(results[i] && typeof(results[i]) == 'object' && results[i].code && results[i].message) { // request error
        					console.error(results[i].message);
        				}
        			}
        		});
    		});
    	});
    }
    
    createEntry(marker) {

    	let entry = new kaltura.objects.MediaEntry({
    		name: marker.title,
    		description: marker.description,
    		mediaType: kaltura.enums.MediaType.VIDEO
    	});

        return new Promise((resolve, reject) => {
        	kaltura.services.media.add(entry)
    		.execute(this.client, (success, entry) => {
    			if(entry.message) { // general transport error
    				reject(entry.message);
    			}
    			else {
    				resolve(entry.id);
    			}
    		});
        });
    }
    
    addMarker(marker) {
        if(marker.recordingId && marker.recordingId.length) {
        	return this.createEntry(marker)
        	.then((entryId) => {
        		this.uploadEntry(entryId, marker.recordingId);
        		return this.addMarkerToDB(marker, entryId);
        	});
        }
        else {
        	return this.addMarkerToDB(marker);
        }
    }
}


let server = new Server();
server.listen(8125);
console.log(`Server running at https://127.0.0.1:8125/`);