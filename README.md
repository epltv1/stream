# Stream Manager

## Setup on VPS
1. git clone https://github.com/YOURUSERNAME/stream-manager.git
2. cd stream-manager
3. npm install
4. pm2 start server.js --name stream-manager
5. sudo cp nginx.conf /etc/nginx/sites-available/default
6. sudo nginx -t && sudo systemctl reload nginx

Access: http://45.33.127.60
Login: admin / slamdrix
