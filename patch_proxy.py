import re

with open('database.js', 'r', encoding='utf-8') as f:
    content = f.read()

proxy_regex = r'const dbProxy = new Proxy\(\{\}, \{.*?\n\}\);'
proxy_replacement = \"\"\"const dbProxy = new Proxy({}, {
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
});\"\"\"

content = re.sub(proxy_regex, proxy_replacement, content, flags=re.DOTALL)

with open('database.js', 'w', encoding='utf-8') as f:
    f.write(content)
