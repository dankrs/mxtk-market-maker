const fs = require('fs');
const path = require('path');

function initializeStorage() {
    try {
        // Get storage directory from environment or use default project path
        const persistentDir = process.env.PERSISTENT_DIR || path.join(__dirname, 'data');
        const walletsDir = path.join(persistentDir, '.wallets');

        console.log('Initializing storage with paths:');
        console.log('Persistent directory:', persistentDir);
        console.log('Wallets directory:', walletsDir);

        // Create directories if they don't exist
        if (!fs.existsSync(persistentDir)) {
            fs.mkdirSync(persistentDir, { recursive: true, mode: 0o755 });
            console.log(`Created persistent directory at: ${persistentDir}`);
        }

        if (!fs.existsSync(walletsDir)) {
            fs.mkdirSync(walletsDir, { recursive: true, mode: 0o755 });
            console.log(`Created wallets directory at: ${walletsDir}`);
        }

        // Ensure proper permissions for existing directories
        fs.chmodSync(persistentDir, 0o755);
        fs.chmodSync(walletsDir, 0o755);

        // Test write permissions
        const testFile = path.join(walletsDir, '.test');
        fs.writeFileSync(testFile, 'test', { mode: 0o644 });
        fs.unlinkSync(testFile);

        console.log('✅ Storage initialization complete with write permissions verified');
    } catch (error) {
        console.error('Error initializing storage:', error);
        console.error('Current working directory:', process.cwd());
        console.error('User:', require('os').userInfo().username);
        throw error;
    }
}

module.exports = initializeStorage; 