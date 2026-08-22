import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Runs an async loader and tracks {data, error, loading}.
 *
 * The loader receives an AbortSignal; passing it through to the API keeps a
 * navigation away from a slow screen from landing its result on the next one.
 */
export function useAsync(loader, deps = [], { immediate = true } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: immediate });
  const controllerRef = useRef(null);
  const mountedRef = useRef(true);

  // Set on every mount, not just cleared on unmount: StrictMode mounts,
  // unmounts and remounts each component in development, and a ref that is
  // only ever set to false would leave every later result discarded — the
  // screen would sit on its skeleton forever despite a successful response.
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; controllerRef.current?.abort(); };
  }, []);

  const run = useCallback(async () => {
    controllerRef.current?.abort();
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const data = await loader({ signal: controller.signal });
      if (controller.signal.aborted || !mountedRef.current) return;
      setState({ data, error: null, loading: false });
      return data;
    } catch (error) {
      if (error.name === 'AbortError' || !mountedRef.current) return;
      setState({ data: null, error, loading: false });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    if (immediate) run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run, immediate]);

  return { ...state, reload: run, setData: (data) => setState((s) => ({ ...s, data })) };
}

/** Tracks an in-flight mutation so a button can disable itself while it runs. */
export function useMutation(fn) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(null);
  const mutate = useCallback(
    async (...args) => {
      setPending(true);
      setError(null);
      try {
        return await fn(...args);
      } catch (err) {
        setError(err);
        throw err;
      } finally {
        setPending(false);
      }
    },
    [fn],
  );
  return { mutate, pending, error };
}
