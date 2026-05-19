#  Axolot SDK

The AI-native CMS infrastructure for Astro.

## Features

- **Code-First Content**: Your code is the schema. Tag any HTML element with `data-slot="key"` and it becomes editable.
- **Zero-Runtime**: 0kB of JavaScript added to your production bundle.
- **Surgical Updates**: AI-driven edits are applied directly to your `.astro` files via a secure dev bridge.
- **AI-Native**: Built from the ground up to be orchestrated by LLMs (Claude, Gemini, GPT).

## Quickstart

### 1. Install

```bash
npm install @axolot-ai/sdk
```

### 2. Configure Astro

Add the integration to `astro.config.mjs`:

```javascript
import { defineConfig } from 'astro/config';
import axolot from '@axolot-ai/sdk';

export default defineConfig({
  integrations: [axolot()],
});
```

### 3. Add the Bridge

Add the `<AxolotBridge />` component to your main layout:

```astro
---
import { AxolotBridge } from '@axolot-ai/sdk/components';
---
<html>
  <body>
    <slot />
    <AxolotBridge />
  </body>
</html>
```

### 4. Tag your slots

```astro
<h1 data-slot="hero.title">Hello World</h1>
```

## Documentation

Full documentation available at [axolot-cms.com/docs](https://axolot-cms.com/docs).

## License

MIT
