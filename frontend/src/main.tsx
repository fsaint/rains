import React from 'react';
import ReactDOM from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import posthog from 'posthog-js';
import { PostHogProvider } from '@posthog/react';
import App from './App';
import { registerHelmAttribution } from './utils/analytics';
import './index.css';

// Helm's PostHog project, the same public key helm.mom loads. The production image is built
// without VITE_POSTHOG_API_KEY, so without this default app.helm.mom sent nothing.
const HELM_POSTHOG_KEY = 'phc_BiDoA9rosBAvP63nkQL4RTVYECT3YUS7BCmCeT7i7nPb';
const posthogKey = (import.meta.env.VITE_POSTHOG_API_KEY as string | undefined) || HELM_POSTHOG_KEY;

// Without an explicit key, only the production build served on helm.mom sends anything: not
// vitest, not vite dev, and not CI's e2e run of the production build on localhost.
const onHelmHost = window.location.hostname === 'helm.mom' || window.location.hostname.endsWith('.helm.mom');
if (import.meta.env.VITE_POSTHOG_API_KEY || (import.meta.env.MODE === 'production' && onHelmHost)) {
  posthog.init(posthogKey, {
    api_host: (import.meta.env.VITE_POSTHOG_HOST as string) || 'https://us.i.posthog.com',
    autocapture: true,
    // A single-page app: a page view on load and on every client-side route change.
    capture_pageview: 'history_change',
    capture_pageleave: true,
    // The app shows credentials, memory and approvals: no text or attributes in autocaptured
    // events, and no session recording whatever the project settings say.
    mask_all_text: true,
    mask_all_element_attributes: true,
    disable_session_recording: true,
    // The marketing machine assigns a visit to a product by $utm_campaign. Registered in loaded,
    // which runs before the initial page view is sent.
    loaded: registerHelmAttribution,
  });
}

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5000,
      refetchOnWindowFocus: false,
    },
  },
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PostHogProvider client={posthog}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </QueryClientProvider>
    </PostHogProvider>
  </React.StrictMode>
);
