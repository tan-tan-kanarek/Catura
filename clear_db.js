/**
 * http://usejsdoc.org/
 */

const sqlite3 = require('sqlite3').verbose();


let db = new sqlite3.Database('./db/db.sqlite');

db.serialize(function() {
	db.run("DELETE FROM markers");
});
    
db.close();