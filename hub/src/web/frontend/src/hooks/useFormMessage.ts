import { useState } from 'react';

type MessageType = 'green' | 'red' | 'yellow';

interface FormMessage {
  text: string;
  color: MessageType;
}

export function useFormMessage() {
  const [msg, setMsg] = useState<FormMessage | null>(null);

  const showSuccess = (text: string) => setMsg({ text, color: 'green' });
  const showError = (err: unknown) => setMsg({ text: err instanceof Error ? err.message : 'Failed', color: 'red' });
  const showWarning = (text: string) => setMsg({ text, color: 'yellow' });
  const clear = () => setMsg(null);

  return { msg, showSuccess, showError, showWarning, clear };
}
