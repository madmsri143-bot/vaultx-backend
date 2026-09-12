import re

with open('database.js', 'r', encoding='utf-8') as f:
    content = f.read()

handler = \"\"\"
        dbInstances[uid] = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error(\Error opening database for user \\, err.message);
            } else {
                console.log(\Connected to isolated SQLite database for user \\);
            }
        });
        
        // Prevent sqlite3 errors from crashing the Node.js process globally
        dbInstances[uid].on('error', (err) => {
            console.error(\[SQLite Error for user \]:\, err.message);
        });
\"\"\"

content = re.sub(r"dbInstances\[uid\] = new sqlite3\.Database\(dbPath.*?\}\);", handler, content, flags=re.DOTALL)

with open('database.js', 'w', encoding='utf-8') as f:
    f.write(content)
