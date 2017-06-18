
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
		
		let This = this;
		
		streamer.record(rtspUrl, filepath, logpath)
		.on('error', (err) => {
			console.error(`Streamer [${id}] error: ${err}`);
		})
		.on('exit', (code, signal) => {
			console.log(`Streamer [${id}] closed, log: ${logpath}`);
			This.done();
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
        let This = this;
        
		let userId = null;
		let type = kaltura.enums.SessionType.USER;
		let expiry = null;
		let privileges = null;
		
		kaltura.services.session.start(kalturaConfig.secret, userId, type, kalturaConfig.partnerId, expiry, privileges)
    	.completion((success, ks) => {
    		if(success) {
        		This.client.setKs(ks);
    		}
    		else {
    			console.error(ks.message);
    		}
    	})
    	.execute(this.client);
    }
	
    listen(port) {
        let This = this;

        const options = {
        	key: fs.readFileSync('keys/server.key'),
        	cert: fs.readFileSync('keys/server.crt'),
        };

		const app = express();
		app.use(express.static('./public'));
		app.post(/.*\.json$/, (request, response) => {
			This.json(request)
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
        .on('new-room', (room, connection) => {
    		room.roomOptions = {
				mediaCodecs : [
					{
						kind        : 'audio',
						name        : 'audio/opus',
						payloadType : 100,
						clockRate   : 48000,
						numChannels : 2
					}
				]
			};
        	if(connection.isMobile) {
        		room.roomOptions.mediaCodecs.push({
					kind      : 'video',
					name      : 'video/vp8',
					payloadType : 101,
					clockRate : 90000
				});
        	}
        	else {
        		room.roomOptions.mediaCodecs.push({
					kind       : 'video',
					name       : 'video/h264',
					payloadType: 103,
					clockRate  : 90000,
					parameters :
					{
						packetizationMode : 1
					}
				});
        	}
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
        	
        	connection.socket
        	.on('init', (isMobile) => {
        		connection.isMobile = isMobile;
        	})
        	.on('record', () => {
        		let sourceId = connection.peerConnection.peer.id;
        		try{
        			This.record(sourceId);
        			connection.socket.emit('recording', sourceId);
        		}
        		catch(err) {
        			connection.socket.emit('error', err);
        		}
        	});
        });

        this.rtspServer = new RtspServer(webRtcServer);
        this.rtspServer
        .listen(5000)
        .on('new-source', (source) => {
        	let rtspUrl = `rtsp://127.0.0.1:${This.rtspServer.port}/${source.id}.sdp`;
        	console.log(`New RTSP source ${rtspUrl}`);
        })
        .on('request', (method, uri) => {
        	console.log(`RTSP [${method}] ${uri}`);
        });
    }

    record(sourceId) {
		if(!this.rtspServer.sources[sourceId]) {
			throw 'Source stream not found';
		}
		
		if(!this.rtspServer.sources[sourceId].enabled) {
			throw 'Source stream not enabled';
		}
			
		console.log(`Source [${sourceId}] recording`);

    	let rtspUrl = `rtsp://127.0.0.1:${this.rtspServer.port}/${sourceId}.sdp`;
		let filepath = `${recordingsPath}/${sourceId}.mp4`;
		let logpath = `${recordingsPath}/${sourceId}.log`;
		
		this.recordings[sourceId] = new Recording(sourceId, rtspUrl, filepath, logpath);
    }

    json(request) {
        let filePath = request.url;
        let method = path.basename(filePath, '.json');
        
        let This = this;

        return new Promise((resolve, reject) => {

            if (!This[method] || typeof (This[method]) !== 'function') {
            	return resolve(null);
            }
            	
            var body = '';
            request.on('data', function (data) {
                body += data;
            });
            request.on('end', function () {
                var data = body.length ? JSON.parse(body) : null;
                This[method](data)
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

        let This = this;
        
        return new Promise((resolve, reject) => {
			This.db.all('SELECT * FROM markers', (err, rows) => {
				if(err) {
					reject(err);
				}
				else {
					resolve(rows.map((row) => This.db2marker(row)));
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
        let This = this;
        
        return new Promise((resolve, reject) => {
        	let d = new Date();
        	let createdAt = d.getTime();
        	
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
        let This = this;
        
        if(marker.recordingId && marker.recordingId.length) {
        	return this.createEntry(marker)
        	.then((entryId) => {
        		This.uploadEntry(entryId, marker.recordingId);
        		return This.addMarkerToDB(marker, entryId);
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