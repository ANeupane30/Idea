"use client";

import { createContext, useContext } from "react";

export type AddSourceTab = "link" | "outline";
export type OpenAddSource = (options?: { tab?: AddSourceTab }) => void;

/** Opens the Add source dialog; null where sources can't be added (e.g. an archived goal). */
export const AddSourceContext = createContext<OpenAddSource | null>(null);

export function useAddSource(): OpenAddSource | null {
  return useContext(AddSourceContext);
}
