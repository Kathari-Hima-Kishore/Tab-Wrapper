from flask import Flask, request, jsonify
from flask_cors import CORS
import requests
import os
import json
import re

app = Flask(__name__)
# Enable CORS so the Chrome Extension can make requests to this backend
CORS(app)

@app.route('/api/organize', methods=['POST'])
def organize_tabs():
    # Vercel will inject this from your Environment Variables
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        return jsonify({"error": "Server misconfiguration: No API key"}), 500

    try:
        data = request.json
        tabs = data.get('tabs', [])
        
        if not tabs:
            return jsonify({"error": "No tabs provided"}), 400

        # 1. Build the prompt
        tabs_data = "\n".join([f"{i+1}. \"{t.get('title', 'Untitled')}\" - {t.get('url', '')}" for i, t in enumerate(tabs)])
        prompt = f"""Group these {len(tabs)} tabs into 2-3 groups. Reply ONLY with JSON array:

[{{"groupName":"Name","color":"blue","tabIds":[1,2]}}]

Tabs:
{tabs_data}

Colors: blue,red,yellow,green,pink,purple,cyan,orange
tabIds: 1-{len(tabs)}"""

        # 2. Call Gemini API
        gemini_url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent"
        headers = {
            'Content-Type': 'application/json',
            'x-goog-api-key': api_key
        }
        payload = {
            "contents": [{"parts": [{"text": prompt}]}]
        }

        gemini_res = requests.post(gemini_url, json=payload, headers=headers)
        gemini_res.raise_for_status()
        result = gemini_res.json()
        
        text = result['candidates'][0]['content']['parts'][0]['text']
        
        # 3. Clean and extract JSON array from Gemini's response
        clean_text = text.replace('```json', '').replace('```', '').strip()
        match = re.search(r'\[[\s\S]*\]', clean_text)
        if match:
            clean_text = match.group(0)
            
        parsed_groups = json.loads(clean_text)
        
        # Return the groups to the extension
        return jsonify({"success": True, "groups": parsed_groups})

    except Exception as e:
        print(f"Error: {str(e)}")
        return jsonify({"success": False, "error": str(e)}), 500

# Required for Vercel
if __name__ == '__main__':
    app.run(debug=True)