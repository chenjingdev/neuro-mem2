import { ChatPage } from './pages/ChatPage';

/**
 * App — root component for the nero-mem2 Visual Debug Chat.
 *
 * Renders ChatPage which composes the full chat + timeline layout
 * with SSE streaming integration via useChatStream.
 */
export function App() {
  return <ChatPage />;
}
