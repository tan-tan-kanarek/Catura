/**
 * http://usejsdoc.org/
 */

const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();

fs.exists('./db', (exists) => {
	if(!exists) {
		fs.mkdirSync('./db');
	}

    let db = new sqlite3.Database('./db/db.sqlite');
    
    db.serialize(function() {
    	db.run("CREATE TABLE markers (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT, description TEXT, entryId TEXT, createdAt INTEGER, lat REAL, lng REAL, userId TEXT)");
    	db.run("CREATE TABLE users (id TEXT PRIMARY KEY, email TEXT, password TEXT, title TEXT, description TEXT, image TEXT, createdAt INTEGER, lat REAL, lng REAL)");
    	db.run("CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, type INTEGER, title TEXT, description TEXT, image TEXT, entryId TEXT, createdAt INTEGER, lat REAL, lng REAL, radius INTEGER, data TEXT)");
    	db.run("CREATE TABLE privateMessages (id INTEGER PRIMARY KEY AUTOINCREMENT, message TEXT, image TEXT, entryId TEXT, createdAt INTEGER, fromUserId TEXT, toUserId TEXT, read INTEGER)");
    });
    
    db.close();
});