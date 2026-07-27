"use client";

import {QueryClient, QueryClientProvider} from "@tanstack/react-query";
import {useState, type ReactNode} from "react";
import {WagmiProvider} from "wagmi";
import {wagmiConfig} from "@/lib/wagmi";

export function Providers({children}: {children: ReactNode}) {
  // Created once per mount so React strict-mode double-rendering does not discard cache.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            // Chain data goes stale in seconds; refetching on window focus is what makes
            // a tab left open overnight show the right round when you come back to it.
            staleTime: 2_000,
            retry: 2,
            refetchOnWindowFocus: true,
          },
        },
      })
  );

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
