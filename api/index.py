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
        tabs_per_group = data.get('tabsPerGroup', 5)
        
        if not tabs:
            return jsonify({"error": "No tabs provided in request"}), 400

        # Build prompt
        tabs_data = "\n".join([f"{i+1}. \"{t.get('title', 'Untitled')}\" - {t.get('url', '')}" for i, t in enumerate(tabs)])
        
        prompt = f"""Organize ALL {len(tabs)} tabs into logical groups. 
PREFERENCE: Aim for approximately {tabs_per_group} tabs per group where possible.

Every single tab ID from 1 to {len(tabs)} MUST be included in exactly one group.
Do not skip any tabs.

Return ONLY a JSON array of groups:
[{{"groupName":"Specific Group Name","color":"blue","tabIds":[1,2,3]}}]

Tabs to organize:
{tabs_data}

Colors allowed: grey, blue, red, yellow, green, pink, purple, cyan, orange"""

        # Using Gemini 3.1 Flash Lite from your available models list
        model_id = "gemini-3.1-flash-lite"
        gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_id}:generateContent"
        
        headers = {
            'Content-Type': 'application/json',
            'x-goog-api-key': api_key
        }
        payload = {
            "contents": [{"parts": [{"text": prompt}]}]
        }

        print(f"Calling Gemini API with model: {model_id}")
        gemini_res = requests.post(gemini_url, json=payload, headers=headers)
        
        if gemini_res.status_code != 200:
            return jsonify({
                "error": f"Model {model_id} error ({gemini_res.status_code})",
                "details": gemini_res.text
            }), gemini_res.status_code
            
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
        return jsonify({"success": False, "error": str(e), "trace": error_msg}), 500

if __name__ == '__main__':
    app.run()