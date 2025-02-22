const fs = require('fs');
const path = require('path');

function initializeStorage() {
    // Get storage directory from environment or use default
    const persistentDir = process.env.PERSISTENT_DIR || path.join(__dirname, 'data');
    const walletsDir = path.join(persistentDir, '.wallets');

    // Create directories if they don't exist
    if (!fs.existsSync(persistentDir)) {
        fs.mkdirSync(persistentDir, { recursive: true });
        console.log(`Created persistent directory at: ${persistentDir}`);
    }

    if (!fs.existsSync(walletsDir)) {
        fs.mkdirSync(walletsDir, { recursive: true });
        console.log(`Created wallets directory at: ${walletsDir}`);
    }

    // Set proper permissions
    fs.chmodSync(persistentDir, '700');
    fs.chmodSync(walletsDir, '700');

    console.log('Storage initialization complete');
}

module.exports = initializeStorage; 