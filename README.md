# paceproject

A starter website with a GitHub Codespaces development environment pre-configured.

## Getting Started

### Open in GitHub Codespaces

Click **Code → Codespaces → Create codespace** to launch a fully configured browser-based editor with all web development tools ready to use.

### Preview the website

Once the codespace opens, right-click `index.html` and select **Open with Live Server**, or run:

```bash
npm start
```

The site will open automatically on port 3000.

## Project Structure

```
├── .devcontainer/
│   └── devcontainer.json   # Codespaces / Dev Container configuration
├── index.html              # Main HTML page
├── style.css               # Styles
├── script.js               # JavaScript
└── package.json            # npm scripts (live-server)
```

## Included VS Code Extensions

- **Live Server** – instant browser preview with auto-reload
- **Prettier** – automatic code formatting
- **ESLint** – JavaScript linting
- **HTML CSS Support** – autocomplete for class names and IDs
- **Auto Close / Rename Tag** – faster HTML editing
- **Color Highlight** – preview CSS colors inline
