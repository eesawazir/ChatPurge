# ChatPurge

Adds checkboxes to the chatgpt.com sidebar so you can delete many chats at once.

## Install
1. Download ZIP and extract to get the extension folder.
2. Open `chrome://extensions` and turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick the `ChatPurge` folder.
4. Open or reload https://chatgpt.com.

## Use
- Click the extension's icon in the Chrome toolbar, or press **Alt+Shift+D**.
- Click rows to tick them. **Shift+click** selects a range.
- **Select all** ticks every chat currently loaded in the sidebar. Scroll the sidebar first to load older chats.
- Click **Delete**, confirm, and wait for the progress message. **Esc** or **Done** exits.

## How it works
It calls the same endpoint the ChatGPT website uses when you delete a chat:
`PATCH /backend-api/conversation/{id}` with `{"is_visible": false}`, authorised with the
token from `/api/auth/session`. Requests are same-origin; nothing is sent anywhere else.

## Caveats
- This is an unofficial, undocumented API. OpenAI can change it or the sidebar markup at
  any time, which would break the extension.
- Deleted chats cannot be restored.
- After a large batch, reload the page so ChatGPT's own sidebar cache catches up.
