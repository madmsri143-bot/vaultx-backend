import re

with open('database.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Currently:
# dbInstances[uid] = new sqlite3.Database(dbPath, (err) => { ... initializeDatabase(dbInstances[uid]); });

# Fix: We want to call initializeDatabase immediately after creating the instance, not in the open callback,
# so that the CREATE TABLE queries are queued FIRST, before the user's queries!
# Actually, the open callback executes after the db is opened.
# If we queue CREATE TABLE synchronously immediately after 
ew sqlite3.Database(dbPath), they are queued first!

new_code = \"\"\"
        dbInstances[uid] = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error(Error opening database for user , err.message);
            } else {
                console.log(Connected to isolated SQLite database for user );
            }
        });
        
        // Queue initialization queries IMMEDIATELY so they execute before any route queries
        initializeDatabase(dbInstances[uid]);
\"\"\"

content = re.sub(r'dbInstances\[uid\] = new sqlite3\.Database\(dbPath, \(err\) => \{.*?initializeDatabase\(dbInstances\[uid\]\);.*?\}\);', new_code, content, flags=re.DOTALL)

with open('database.js', 'w', encoding='utf-8') as f:
    f.write(content)
