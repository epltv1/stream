#!/bin/bash
echo "Deploying..."
git pull origin main
npm install
pm2 restart stream-manager || pm2 start server.js --name stream-manager
echo "Done! Access at http://45.33.127.60"
