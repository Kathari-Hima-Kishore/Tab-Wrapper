from flask import Flask, request, jsonify
from flask_cors import CORS
import requests
import os
import json
import re
import traceback

app = Flask(__name__)
CORS(app)

@app.route('/', methods=['GET'])
def health():
    return jsonify({"status": "alive", "message": "Tab Wrapper Backend is running"}), 200

@app.route('/api/organize', methods=['POST', 'GET'])
def organize_tabs():
    if request.method == 'GET':
        return jsonify({"message": "Use POST to send tabs"}), 200

    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return jsonify({"error": "No API key set on server"}), 500

    try:
        data = request.json
        if not data:
            return jsonify({"error": "No JSON payload provided"}), 400
            
        tabs = data.get('tabs', [])
        if not tabs:
            return jsonify({"error": "No tabs provided in request"}), 400

        # Build prompt
        tabs_data = "\n".join([f"{i+1}. \"{t.get('title', 'Untitled')}\" - {t.get('url', '')}" for i, t in enumerate(tabs)])
        prompt = f"""Group these {len(tabs)} tabs into 2-3 groups. Reply ONLY with JSON array:
[{{"groupName":"Name","color":"blue","tabIds":[1,2]}}]

Tabs:
{tabs_data}

Colors: blue,red,yellow,green,pink,purple,cyan,orange
tabIds: 1-{len(tabs)}"""

        # Call Gemini
        gemini_url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent"
        headers = {
            'Content-Type': 'application/json',
            'x-goog-api-key': api_key
        }
        payload = {
            "contents": [{"parts": [{"text": prompt}]}]
        }

        gemini_res = requests.post(gemini_url, json=payload, headers=headers)
        
        if gemini_res.status_code != 200:
            return jsonify({"error": f"Gemini API error: {gemini_res.text}"}), 500
            
        result = gemini_res.json()
        text = result['candidates'][0]['content']['parts'][0]['text']
        
        # Extract JSON
        clean_text = text.replace('```json', '').replace('```', '').strip()
        match = re.search(r'\[[\s\S]*\]', clean_text)
        if match:
            clean_text = match.group(0)
            
        parsed_groups = json.loads(clean_text)
        return jsonify({"success": True, "groups": parsed_groups})

    except Exception as e:
        error_msg = traceback.format_exc()
        print(f"Server Error: {error_msg}")
        return jsonify({"success": False, "error": str(e), "trace": error_msg}), 500

# For Vercel, use 'app' as the entry point
if __name__ == '__main__':
    app.run()