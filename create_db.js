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
    	db.run("CREATE TABLE markers (id INTEGER PRIMARY KEY, title TEXT, description TEXT, entryId TEXT, createdAt INTEGER, lat REAL, lng REAL)");
    });
    
    db.close();
});