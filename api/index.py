from flask import Flask, request, jsonify
from flask_cors import CORS
import requests
import os
import json
import re
import time
import traceback

app = Flask(__name__)
CORS(app)

# Reuse the TCP/TLS connection across calls. A fresh handshake on every
# request is slow enough to time out on a cold serverless start.
session = requests.Session()

# Transient Gemini conditions that are worth retrying
RETRYABLE_CODES = {429, 500, 502, 503, 504}

def friendly_error(status_code, detail):
    """Turn a Gemini API error into a short message a user can act on."""
    lowered = (detail or "").lower()
    if status_code in (503, 502, 504) or 'high demand' in lowered or 'unavailable' in lowered:
        return "The AI model is busy right now. Please try again in a moment."
    if status_code == 429 or 'quota' in lowered or 'rate' in lowered:
        return "Too many requests right now. Please wait a few seconds and retry."
    if status_code in (401, 403):
        return "The server's AI key was rejected. Check the GEMINI_API_KEY configuration."
    if status_code == 400:
        return "The AI model rejected the request payload."
    return "The AI model could not complete the request. Please try again."

@app.route('/', methods=['GET'])
def health():
    return jsonify({"status": "alive", "message": "Tab Wrapper Backend is running"}), 200

@app.route('/api/speed', methods=['GET'])
def speed_payload():
    """Serve a known-size incompressible payload for a throughput measurement.

    The client times how long this takes to arrive and converts the result to
    Mbps. Random bytes are used because they do not compress: a compressible
    payload would arrive far smaller than declared and the maths would be wrong.
    The cache is disabled so every request is a real transfer, not a replay.
    """
    try:
        size = int(request.args.get("bytes", 1048576))
    except (TypeError, ValueError):
        size = 1048576

    # Cap the response so this endpoint can never be used to generate a huge
    # download for free.
    size = max(1024, min(size, 4 * 1024 * 1024))

    return app.response_class(
        os.urandom(size),
        mimetype="application/octet-stream",
        headers={
            "Cache-Control": "no-store, no-cache, must-revalidate",
            "Content-Length": str(size),
        },
    )

@app.route('/api/organize', methods=['POST', 'GET'])
def organize_tabs():
    if request.method == 'GET':
        return jsonify({"message": "Use POST to send tabs"}), 200

    api_key = os.environ.get("GEMINI_API_KEY", "").strip()
    if not api_key:
        return jsonify({"error": "No API key set on server"}), 500

    try:
        data = request.json
        if not data:
            return jsonify({"error": "No JSON payload provided"}), 400
            
        tabs = data.get('tabs', [])

        if not tabs:
            return jsonify({"error": "No tabs provided in request"}), 400

        # Let the model choose the number of groups, their names, and their
        # colours. Nothing about the output shape is prescribed.
        tabs_data = "\n".join([f"{i+1}. \"{t.get('title', 'Untitled')}\" - {t.get('url', '')}" for i, t in enumerate(tabs)])

        prompt = f"""You are organizing a user's browser tabs.

Decide the grouping entirely from the tab content below: how many groups exist,
which tabs belong to each, what each group is called, and what colour suits it.
There is no target group count and no target size per group. Let the material
decide.

Rules:
- Every tab ID from 1 to {len(tabs)} must appear in exactly one group.
- Group names should describe the shared subject, not the tab count.
- Colours must be valid Chrome tab group colours.

Respond with ONLY a JSON array, no prose and no code fences:
[{{"groupName":"...","color":"...","tabIds":[1,2,3]}}]

Tabs:
{tabs_data}"""

        # Use model ID from environment variable or fallback to requested model
        model_id = os.environ.get("GEMINI_MODEL_ID")
        if not model_id:
            return jsonify({"error": "AI model is not configured on the server"}), 500
        gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_id}:generateContent?key={api_key}"
        
        # Logging for Vercel monitoring to confirm which model is being used
        print(f"Backend: Attempting to use model: {model_id}")
        
        headers = {
            'Content-Type': 'application/json'
        }
        payload = {
            "contents": [{"parts": [{"text": prompt}]}]
        }

        # Gemini returns 503/429 under load. Retry briefly before giving up.
        gemini_res = None
        for attempt in range(3):
            try:
                gemini_res = session.post(gemini_url, json=payload, headers=headers, timeout=25)
            except requests.exceptions.RequestException as req_err:
                print(f"Backend: request attempt {attempt + 1} failed: {req_err}")
                if attempt == 2:
                    return jsonify({"error": "Could not reach the AI service. Check your connection and try again."}), 503
                time.sleep(1.5 * (attempt + 1))
                continue

            if gemini_res.status_code not in RETRYABLE_CODES:
                break

            print(f"Backend: Gemini returned {gemini_res.status_code} on attempt {attempt + 1}")
            if attempt < 2:
                time.sleep(1.5 * (attempt + 1))

        if gemini_res is None or gemini_res.status_code != 200:
            status = gemini_res.status_code if gemini_res is not None else None
            detail = gemini_res.text if gemini_res is not None else "no response"
            print(f"Gemini API Error: Status {status}, Response: {detail}")
            # Return a human-readable message; the raw API JSON stays in logs.
            return jsonify({"error": friendly_error(status, detail)}), 503
            
        result = gemini_res.json()

        # A blocked or empty generation has no candidates; fail clearly instead
        # of raising a KeyError further down.
        candidates = result.get('candidates') or []
        if not candidates or 'content' not in candidates[0]:
            reason = (result.get('promptFeedback') or {}).get('blockReason', 'no candidates returned')
            print(f"Backend: Gemini returned no usable content: {reason}")
            return jsonify({"error": "The AI did not return any grouping. Please try again."}), 503

        text = candidates[0]['content']['parts'][0]['text']

        # Extract JSON
        clean_text = text.replace('```json', '').replace('```', '').strip()
        match = re.search(r'\[[\s\S]*\]', clean_text)
        if match:
            clean_text = match.group(0)

        parsed_groups = json.loads(clean_text)
        return jsonify({"success": True, "groups": parsed_groups})

    except Exception as e:
        # Log the full trace for Vercel; return something readable to the client.
        print(f"Backend: unhandled error: {traceback.format_exc()}")
        return jsonify({"success": False, "error": "Something went wrong organizing your tabs. Please try again."}), 500

if __name__ == '__main__':
    app.run()