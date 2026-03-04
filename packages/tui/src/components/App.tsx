/**
 * @module components/App
 * Root TUI application component. Composes ChatView and StatusBar.
 */

import React from 'react';
import { Box } from 'ink';
import { ChatView } from './ChatView.js';
import { StatusBar } from './StatusBar.js';
import { useGateway } from '../hooks/use-gateway.js';

/** Props for the root App component. */
interface AppProps {
  /** Gateway WebSocket URL. */
  gatewayUrl: string;
  /** Authentication token. */
  token: string;
}

/**
 * Root application component.
 * Connects to the gateway and renders the chat view with a status bar.
 */
export function App({ gatewayUrl, token }: AppProps): React.ReactElement {
  const gw = useGateway({ url: gatewayUrl, token });

  return (
    <Box flexDirection="column" height="100%">
      <ChatView
        messages={gw.messages}
        thinking={gw.thinking}
        activePlan={gw.activePlan}
        onSend={gw.sendChat}
        onCommand={gw.sendCommand}
        onPlanRespond={(action, modification) => {
          if (gw.activePlanId) {
            gw.respondToPlan(gw.activePlanId, action, modification);
          }
        }}
      />
      <StatusBar
        connected={gw.connected}
        graphState={gw.graphState}
        recentEvents={gw.recentEvents}
      />
    </Box>
  );
}
