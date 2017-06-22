
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

const MessageType = {
	FEEDER_WANTED: 1,
	VET_WANTED: 2,
	CAT_WANTED: 3,
	FOOD_GIVEAWAY: 4,
	CAT_LOST: 5
};

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
        	
        	connection.socket
        	.on('add-user', (user) => {
        		console.log(`Connection [${connection.id}] adding user`, user);
        		connection.userId = user.id;
        		this.addUser(user);
        	})
        	.on('login', (email, password) => {
        		console.log(`Connection [${connection.id}] logging in user [${email}]`);
        		this.login(email, password)
        		.then((user) => {
        			connection.socket.emit('login', user);
        		});
        	})
        	.on('login-with-id', (userId) => {
        		console.log(`Connection [${connection.id}] logging in user with id [${userId}]`);
        		connection.userId = userId;
        	})
        	.on('update-user', (user) => {
        		console.log(`Connection [${connection.id}] updating user [${connection.userId}]`, user);
        		this.updateUser(connection.userId, user);
        	})
        	.on('get-user', (userId) => {
        		if(!userId) {
        			userId = connection.userId;
        		}
        		console.log(`Connection [${connection.id}] getting user [${userId}]`);
        		this.getUser(userId)
        		.then((user) => {
        			if(userId === connection.userId) {
        				connection.socket.emit('get-me', user);
        			}
        			else {
        				connection.socket.emit('get-user', user);
        			}
        		});
        	})
        	.on('send-message', (message) => {
        		message.userId = connection.userId;
        		console.log(`Connection [${connection.id}] sending message`, message);
        		this.sendMessage(message)
        		.then((messageId) => {
       				connection.socket.emit('message-sent', messageId);
        		});
        	})
        	.on('send-private-message', (toUserId, message) => {
        		message.fromUserId = connection.userId;
        		console.log(`Connection [${connection.id}] sending message`, message);
        		this.sendPrivateMessage(message)
        		.then((messageId) => {
       				connection.socket.emit('private-message-sent', messageId);
        		});
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


	addUser(user) {
    	let d = new Date();
    	let createdAt = d.getTime();
    	let columns = ['id', 'createdAt'];
    	let values = [user.id, createdAt];
    	
    	if(user.email) {
        	columns.push('email');
        	values.push(user.email);
    	}

    	if(user.password) {
        	columns.push('password');
        	values.push(user.password);
    	}

    	if(user.title) {
        	columns.push('title');
        	values.push(user.title);
    	}

    	if(user.description) {
        	columns.push('description');
        	values.push(user.description);
    	}

    	if(user.image) {
        	columns.push('image');
        	values.push(user.image);
    	}
    	let columnsStr = columns.join(', ');
    	let valuesStr = values.map(() => '?').join(', ');
    	
    	let sql = `INSERT INTO users (${columnsStr}) VALUES (${valuesStr})`;
    	console.log(`SQL: ${sql}`);
    	this.db.run(sql, values, (err) => {
			if(err) {
				console.error(err);
			}
		});
	}

	login(email, password) {
        return new Promise((resolve, reject) => {
    		let sql = `SELECT * FROM users WHERE email = ?`;
    		console.log(`SQL: ${sql}`);
        	this.db.all(sql, [email], (err, row) => {
    			if(err) {
    				reject('User not found');
    			}
    			else {
    				let user = this.db2marker(row);
    				if(password === user.password) {
    					delete user.password;
    					resolve(user);
    				}
    				else {
    					reject('Wrong password');
    				}
    			}
    		});
		});
	}

	updateUser(userId, user) {
    	let values = [];
    	let updates = [];
    	
    	if(user.email) {
    		updates.push('email = ?');
        	values.push(user.email);
    	}

    	if(user.password) {
    		updates.push('password = ?');
        	values.push(user.password);
    	}

    	if(user.title) {
    		updates.push('title = ?');
        	values.push(user.title);
    	}

    	if(user.description) {
    		updates.push('description = ?');
        	values.push(user.description);
    	}

    	if(user.image) {
    		updates.push('image = ?');
        	values.push(user.image);
    	}
    	let updatesStr = updates.join(', ');
    	values.push(userId);

    	let sql = `UPDATE users SET ${updatesStr} WHERE id = ?`;    	
    	console.log(`SQL: ${sql}`);
    	this.db.run(sql, values, (err) => {
			if(err) {
				console.error(err);
			}
		});
	}

	getUser(userId) {
        return new Promise((resolve, reject) => {
    		let sql = `SELECT * FROM users WHERE id = ?`;
    		console.log(`SQL: ${sql}`);
        	this.db.all(sql, [userId], (err, row) => {
    			if(err) {
    				reject('User not found');
    			}
    			else {
    				resolve(row);
    			}
    		});
		});
	}
	
	sendMessage(message) {
        return new Promise((resolve, reject) => {
        	let d = new Date();
        	let createdAt = d.getTime();
        	let columns = ['type', 'createdAt'];
        	let values = [message.type, createdAt];
        	
        	if(message.title) {
            	columns.push('title');
            	values.push(message.title);
        	}
    
        	if(message.description) {
            	columns.push('description');
            	values.push(message.description);
        	}
    
        	if(message.image) {
            	columns.push('image');
            	values.push(message.image);
        	}
    
        	if(message.lat) {
            	columns.push('lat');
            	values.push(message.lat);
        	}
    
        	if(message.lng) {
            	columns.push('lng');
            	values.push(message.lng);
        	}
    
        	if(message.radius) {
            	columns.push('radius');
            	values.push(message.radius);
        	}
        	
        	let columnsStr = columns.join(', ');
        	let valuesStr = values.map(() => '?').join(', ');
        	
        	let sql = `INSERT INTO messages (${columnsStr}) VALUES (${valuesStr})`;
        	console.log(`SQL: ${sql}`);
        	this.db.run(sql, values, function(err) {
    			if(err) {
    				console.error(err);
    			}
    
    			resolve(this.lastID);
    		});
		});
	}

	sendPrivateMessage(message) {
        return new Promise((resolve, reject) => {
        	let d = new Date();
        	let createdAt = d.getTime();
        	let columns = ['createdAt', 'message', 'fromUserId', 'toUserId'];
        	let values = [createdAt, message.message, message.fromUserId, message.toUserId];
        	
        	if(message.image) {
            	columns.push('image');
            	values.push(message.image);
        	}
        	
        	let columnsStr = columns.join(', ');
        	let valuesStr = values.map(() => '?').join(', ');
        	
        	let sql = `INSERT INTO privateMessages (${columnsStr}) VALUES (${valuesStr})`;
        	console.log(`SQL: ${sql}`);
        	this.db.run(sql, values, function(err) {
    			if(err) {
    				console.error(err);
    			}
    
    			resolve(this.lastID);
    		});
		});
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
    		let d = new Date();
    		let deprecatedTime = d.getTime() - (1000 * 60 * 60 * 12); // 12 hours ago

    		let sql = `SELECT * FROM markers WHERE createdAt > ${deprecatedTime}`;
    		console.log(`SQL: ${sql}`);
        	this.db.all(sql, (err, rows) => {
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
            userId : row.userId,
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
        	
        	let sql = 'INSERT INTO markers (title, description, entryId, createdAt, lat, lng, userId) VALUES (?, ?, ?, ?, ?, ?, ?)';
        	console.log(`SQL: ${sql}`);
        	this.db.run(sql, [marker.title, marker.description, entryId, createdAt, marker.position.lat, marker.position.lng, marker.userId], function(err) {
    			if(err) {
    				return reject(err);
    			}
    
    			let lastID = this.lastID;
    			let sql = `SELECT * FROM markers WHERE id = ${lastID}`;
    			console.log(`SQL: ${sql}`);
    			This.db.get(sql, (err, row) => {
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