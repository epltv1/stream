# Stream Manager

Live streaming dashboard with login, stream management, and custom player.

## Setup on VPS
1. `git clone https://github.com/epltv1/stream.git`
2. `cd stream`
3. `npm install`
4. `pm2 start server.js --name stream-manager`
5. `sudo cp nginx.conf /etc/nginx/sites-available/default`
6. `sudo nginx -t && sudo systemctl reload nginx`

## Access
- URL: http://45.33.127.60
- Login: admin / slamdrix
- Embed restricted to: futbol-x.site

## Features
- Login-protected dashboard
- Start/stop streams
- Real-time viewer count
- Custom player (PiP, quality, fullscreen)
- Sidebar navigation
- Dark/light theme toggle
