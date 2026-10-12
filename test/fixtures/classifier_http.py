"""Dedicated Python transport fixture; never loads production state or model."""
import json
import os
import time
from email.parser import BytesParser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def respond(self, payload):
        body = json.dumps(payload).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self.respond({"status": "ready"})

    def do_POST(self):
        body = self.rfile.read(int(self.headers["Content-Length"]))
        message = BytesParser().parsebytes(
            ("Content-Type: " + self.headers["Content-Type"] + "\r\nMIME-Version: 1.0\r\n\r\n").encode() + body
        )
        request_id = next(part.get_payload(decode=True).decode() for part in message.walk()
                          if part.get_param("name", header="content-disposition") == "requestId")
        print("CLASSIFY_STARTED", flush=True)
        time.sleep(float(os.environ.get("TEST_CLASSIFIER_DELAY", "0")))
        self.respond({"requestId": request_id,
                      "result": {"name": "Nấm thử", "edibility": "NON_POISONOUS", "confidence": 0.9}})


ThreadingHTTPServer(("127.0.0.1", int(os.environ["TEST_CLASSIFIER_PORT"])), Handler).serve_forever()
