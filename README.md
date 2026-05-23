#  Axolot SDK — The AI-Native CMS Integration for Astro

[![NPM Version](https://img.shields.io/npm/v/@axolot-ai/sdk?color=E67E22&style=flat-square)](https://www.npmjs.com/package/@axolot-ai/sdk)
[![Astro Version](https://img.shields.io/badge/Astro-v5.0+-BC3FEE?style=flat-square)](https://astro.build)
[![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)](https://github.com/axolot-ai/sdk/blob/main/LICENSE)

**Axolot SDK** (`@axolot-ai/sdk`) is the developer gateway to **Axolot CMS** — an ultra-lightweight, modular, and AI-native multi-tenant headless CMS built specifically for web design agencies and modern frontend developers.

It connects your local **Astro** layouts directly with the **Axolot Live Visual Editor** and autonomous AI agents, combining absolute design control with no-code client content editing.

> 💡 **The Philosophy**: **Apple simplicity. Developer power. AI-native.**

---

## ⚡ Why Axolot SDK?

Unlike traditional heavy database-driven CMSs (like WordPress) or complex API-only headless CMSs (like Contentful), Axolot works **code-first**:

*   **Zero Production JavaScript (Zero JS)**: The SDK parses and processes everything at build time. Your production site compiles to pure static HTML/CSS with a **Lighthouse Performance Score of 100**.
*   **Surgical Local Code Updates**: During development, the SDK starts a secure WebSocket dev tunnel. When the client edits text or images in the cloud editor, changes are written **directly** into your local `.astro` files as clean code.
*   **AI-Native & MCP Powered**: Exposes a direct link to the Model Context Protocol (MCP) server, allowing local AI assistants (Cursor, Claude Desktop, Antigravity) to read design tokens, upload media, and build sections using your exact CSS system.
*   **Structured Content Modules**: Built-in support for standard modules like **Blog Pro**, **Tienda Online (E-commerce)**, **Reseñas Pro**, and **Consultor IA**.

---

## 🚀 Quickstart Guide

### 1. Installation

Install the package in your Astro project directory:

```bash
npm install @axolot-ai/sdk
# or
pnpm add @axolot-ai/sdk
# or
yarn add @axolot-ai/sdk
```

### 2. Configure Astro

Add the `axolot` integration to your [astro.config.mjs](file:///c:/Users/byhug/Desktop/Axolot_secret/sites/oaxhosting/astro.config.mjs):

```javascript
import { defineConfig } from 'astro/config';
import tailwind from '@astrojs/tailwind'; // optional
import axolot from '@axolot-ai/sdk';

export default defineConfig({
  integrations: [
    tailwind(),
    axolot(), // Connects the local dev server with the CMS API
  ],
});
```

### 3. Setup Environment Variables

Create a `.env` file in the root of your project:

```env
# Credentials obtained from your Axolot Dashboard
AXOLOT_SITE_ID="your-site-uuid-here"
AXOLOT_API_TOKEN="your-api-key-here"

# API Endpoint (Defaults to production)
AXOLOT_API_URL="https://api.axolotcms.com"
```

### 4. Inject the Sync Bridge

Add the `<AxolotBridge />` component to your main layout file (usually `src/layouts/Layout.astro`). This handles page auto-syncing and visual select clicks when loaded inside the Dashboard Iframe.

```astro
---
import { AxolotBridge } from '@axolot-ai/sdk/components';
---
<!DOCTYPE html>
<html lang="es">
  <head>
    <meta charset="utf-8" />
    <title>My Astro Site</title>
  </head>
  <body>
    <!-- Your layout content -->
    <slot />
    
    <!-- Render dev bridge ONLY in development mode -->
    <AxolotBridge />
  </body>
</html>
```

### 5. Define Editable Slots

Tag any element in your Astro templates. The SDK will register them automatically, making them immediately editable in the cloud.

```astro
---
import { Slot } from '@axolot-ai/sdk/components';
---

<header class="hero-section">
  <!-- Dynamic text slot -->
  <Slot id="home.hero.title" type="text" placeholder="Especialistas en tu sonrisa" />
  
  <!-- Dynamic CTA link -->
  <Slot id="home.hero.cta" type="link" placeholder="/contacto">
    <a class="btn-primary">¡Reservar cita!</a>
  </Slot>
</header>
```

---

## ⚙️ How the Dev Bridge works

When running `pnpm dev`, the SDK runs a local server that exposes three endpoints under `/_axolot/fs`:
*   `POST /_axolot/fs/read` - Returns the source code of components to the visual editor.
*   `POST /_axolot/fs/write` - Writes visual edits back to Astro files.
*   `GET /_axolot/fs/list` - Lists current pages.

All endpoints are strictly authenticated using your `AXOLOT_API_TOKEN` and secured behind a private signature validation to prevent arbitrary local file reading/writing.

---

## 🔗 Useful Links

*   **Official Website**: [axolotcms.com](https://axolotcms.com)
*   **Client Dashboard**: [app.axolotcms.com](https://app.axolotcms.com)
*   **Documentation & API Reference**: [axolotcms.com/docs](https://axolotcms.com/docs)
*   **Hosting Partner**: [oaxhosting.com](https://oaxhosting.com)

---

## 🛡️ Security & Privacy

Axolot CMS does not store your code layouts in the cloud database unless you perform a production build. All development changes occur strictly between your local machine and the editor client via secure WebSocket tunnels. Marketing credentials and third-party API keys (Stripe, Google Ads) are encrypted using **AES-256-GCM** inside tenant-isolated database schemas.

## 📄 License

Distributed under the MIT License. See `LICENSE` for more information.
