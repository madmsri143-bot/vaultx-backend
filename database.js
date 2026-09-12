const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const bcrypt = require('bcrypt');
const { AsyncLocalStorage } = require('async_hooks');

const asyncLocalStorage = new AsyncLocalStorage();
const dbInstances = {};

function initializeDatabase(db) {
    db.serialize(() => {
        // Users Table
        db.run(`CREATE TABLE IF NOT EXISTS user (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            password_hash TEXT NOT NULL
        )`);

        // Insert default user if not exists
        db.get("SELECT * FROM user", (err, row) => {
            if (!row) {
                const saltRounds = 10;
                bcrypt.hash('admin123', saltRounds, (err, hash) => {
                    db.run("INSERT INTO user (password_hash) VALUES (?)", [hash]);
                });
            }
        });

        // Add currency column if missing
        db.run("ALTER TABLE user ADD COLUMN currency TEXT DEFAULT 'INR'", (err) => {});
        db.run("ALTER TABLE user ADD COLUMN display_name TEXT DEFAULT 'User'", (err) => {});
        db.run("ALTER TABLE user ADD COLUMN profile_picture TEXT DEFAULT ''", (err) => {});
        db.run("ALTER TABLE user ADD COLUMN email TEXT DEFAULT 'user@vault.local'", (err) => {});

        // Payouts Table
        db.run(`CREATE TABLE IF NOT EXISTS payouts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            amount REAL NOT NULL,
            note TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            allocations TEXT
        )`);

        // Budget Funding Table
        db.run(`CREATE TABLE IF NOT EXISTS budget_funding (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            type TEXT,
            source_name TEXT,
            goal_id INTEGER,
            amount REAL,
            notes TEXT,
            date DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        
        // Closed Months Table
        db.run(`CREATE TABLE IF NOT EXISTS closed_months (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            month_year TEXT UNIQUE,
            budget REAL,
            expenses REAL,
            remaining_balance REAL,
            closed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            snapshot_json TEXT
        )`);
        
        // Transfer History Table
        db.run(`CREATE TABLE IF NOT EXISTS transfer_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            previous_month TEXT,
            transfer_date DATETIME DEFAULT CURRENT_TIMESTAMP,
            remaining_balance REAL,
            savings_amount REAL,
            goals_amount REAL,
            carry_forward_amount REAL,
            allocations TEXT
        )`);

        // Direct Contributions Table
        db.run(`CREATE TABLE IF NOT EXISTS direct_contributions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            amount REAL NOT NULL,
            note TEXT,
            allocation_type TEXT,
            allocations TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Goals Table
        db.run(`CREATE TABLE IF NOT EXISTS goals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            target_amount REAL NOT NULL,
            saved_amount REAL DEFAULT 0,
            notes TEXT,
            status TEXT DEFAULT 'Active',
            completed_at DATETIME,
            archived_at DATETIME,
            icon TEXT DEFAULT 'dYZ_',
            weight INTEGER DEFAULT 0
        )`);

        // Funds Table
        db.run(`CREATE TABLE IF NOT EXISTS funds (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            balance REAL DEFAULT 0
        )`);

        // Insert default funds
        db.get("SELECT count(*) as count FROM funds", (err, row) => {
            if (row && row.count === 0) {
                const stmt = db.prepare("INSERT INTO funds (name, balance) VALUES (?, ?)");
                stmt.run("Expenses", 0);
                stmt.run("Personal Savings", 0);
                stmt.finalize();
            }
        });

        // Priority Tasks Table
        db.run(`CREATE TABLE IF NOT EXISTS priority_tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            description TEXT,
            status TEXT DEFAULT 'Pending'
        )`);

        // Subtasks Table
        db.run(`CREATE TABLE IF NOT EXISTS subtasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            task_id INTEGER,
            title TEXT NOT NULL,
            status TEXT DEFAULT 'Pending',
            FOREIGN KEY (task_id) REFERENCES priority_tasks(id)
        )`);

        // Transactions Table
        db.run(`CREATE TABLE IF NOT EXISTS transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date DATETIME DEFAULT CURRENT_TIMESTAMP,
            action TEXT NOT NULL,
            amount REAL,
            details TEXT
        )`);

        // Expenses Table
        db.run(`CREATE TABLE IF NOT EXISTS expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            amount REAL NOT NULL,
            category TEXT NOT NULL,
            description TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Expense Transfers Table
        db.run(`CREATE TABLE IF NOT EXISTS expense_transfers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            date TEXT NOT NULL,
            amount REAL NOT NULL,
            destination_type TEXT NOT NULL,
            destination_name TEXT NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        
        // Currency Conversions
        db.run(`CREATE TABLE IF NOT EXISTS currency_conversions (
            id INTEGER PRIMARY KEY AUTOINCREMENT, 
            from_currency TEXT, 
            to_currency TEXT, 
            rate REAL, 
            date DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
    });
}

function getDb() {
    const store = asyncLocalStorage.getStore();
    const uid = store && store.uid ? store.uid : 'default';
    
    if (!dbInstances[uid]) {
        const safeUid = uid.replace(/[^a-zA-Z0-9_-]/g, '_');
        const dataDir = process.env.DATA_DIR || __dirname;
        const dbPath = path.resolve(dataDir, `database_${safeUid}.sqlite`);
        
        
        dbInstances[uid] = new sqlite3.Database(dbPath, (err) => {
            if (err) {
                console.error(`Error opening database for user ${uid}`, err.message);
            } else {
                console.log(`Connected to isolated SQLite database for user ${uid}`);
            }
        });
        
        // Prevent sqlite3 errors from crashing the Node.js process globally
        dbInstances[uid].on('error', (err) => {
            console.error(`[SQLite Error for user ${uid}]:`, err.message);
        });
        
        // Queue initialization queries IMMEDIATELY so they execute before any route queries
        initializeDatabase(dbInstances[uid]);

    }
    return dbInstances[uid];
}

const dbProxy = new Proxy({}, {
    get: (target, prop) => {
        const db = getDb();
        const val = db[prop];
        if (typeof val === 'function') {
            return (...args) => {
                const store = asyncLocalStorage.getStore();
                const boundArgs = args.map(arg => {
                    if (typeof arg === 'function') {
                        return function(...cbArgs) {
                            return asyncLocalStorage.run(store, () => arg.apply(this, cbArgs));
                        };
                    }
                    return arg;
                });
                return val.apply(db, boundArgs);
            };
        }
        return val;
    }
});

module.exports = { db: dbProxy, asyncLocalStorage };
