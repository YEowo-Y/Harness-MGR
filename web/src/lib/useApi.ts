import { useEffect, useState, type DependencyList } from "react";

export interface ApiState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

/**
 * Run an async fetcher and expose {data, loading, error}. The `deps` array drives
 * refetch (e.g. [target, reloadKey]); an `ignore` flag makes the latest request win
 * on rapid dep changes and neutralizes React 19 StrictMode's dev double-invoke.
 * The fetcher is intentionally NOT a dep — it already closes over `deps`.
 *
 * IMPORTANT: pass ONLY primitive deps (strings, numbers, booleans). The array is
 * forwarded straight into useEffect with exhaustive-deps disabled, so an
 * object/array literal would change identity every render and refetch in a loop.
 */
export function useApi<T>(
  fetcher: () => Promise<T>,
  deps: DependencyList,
): ApiState<T> {
  const [state, setState] = useState<ApiState<T>>({
    data: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    let ignore = false;
    setState((s) => ({ ...s, loading: true, error: null }));
    fetcher()
      .then((data) => {
        if (!ignore) setState({ data, loading: false, error: null });
      })
      .catch((e) => {
        if (!ignore)
          setState({
            data: null,
            loading: false,
            error: e instanceof Error ? e.message : String(e),
          });
      });
    return () => {
      ignore = true;
    };
    // fetcher omitted by design (see doc comment) — deps drive the refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return state;
}
