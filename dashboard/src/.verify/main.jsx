import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useAsync } from '/Users/mac/frappe/frappe-bench/apps/techsarena_hr/dashboard/src/hooks/useAsync.js';

let callCount = 0;
const fakeApi = ({ signal }) => new Promise((resolve, reject) => {
  callCount += 1;
  const t = setTimeout(() => resolve({ ok: true, call: callCount }), 60);
  signal?.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
});

// Mirrors ProfileDrawer: conditional loader + immediate flag, mounted only
// once a row is "clicked", which is when the StrictMode remount bites.
function Drawer({ id }) {
  const state = useAsync(({ signal }) => (id ? fakeApi({ signal }) : Promise.resolve(null)), [id], { immediate: Boolean(id) });
  return <div id="drawer" data-loading={String(state.loading)} data-haserror={String(Boolean(state.error))}>
    {state.data ? `DATA call=${state.data.call}` : state.error ? `ERROR ${state.error.message}` : 'SKELETON'}
  </div>;
}
function App() {
  const [id, setId] = useState(null);
  return <><button id="open" onClick={() => setId('HR-EMP-00008')}>open</button>
    <button id="switch" onClick={() => setId('HR-EMP-00009')}>switch</button>
    {id && <Drawer id={id} />}</>;
}
createRoot(document.getElementById('root')).render(<StrictMode><App /></StrictMode>);
