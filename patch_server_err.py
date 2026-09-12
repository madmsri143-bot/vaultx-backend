import re

with open('server.js', 'r', encoding='utf-8') as f:
    content = f.read()

# Append error middleware before app.listen
middleware = \"\"\"
// Global Error Handler Middleware
app.use((err, req, res, next) => {
    console.error('Unhandled Server Error:', err);
    res.status(500).json({ error: 'Internal Server Error' });
});

\"\"\"

content = content.replace("app.listen(PORT, () => {", middleware + "app.listen(PORT, () => {")

with open('server.js', 'w', encoding='utf-8') as f:
    f.write(content)
