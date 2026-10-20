"use client";

import { createContext, useContext } from "react";

/** Opens the Add source dialog; null where sources can't be added (e.g. an archived goal). */
export const AddSourceContext = createContext<(() => void) | null>(null);

export function useAddSource(): (() => void) | null {
  return useContext(AddSourceContext);
}
