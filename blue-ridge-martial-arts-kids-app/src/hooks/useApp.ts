import { useContext } from 'react'
import { AppContext, type AppStore } from '../app/context'

/** Reads the store. Throws rather than returning a null the caller would have
 *  to guard on every line — a component outside the provider is a wiring bug,
 *  not a runtime state. */
export function useApp(): AppStore {
  const store = useContext(AppContext)
  if (!store) throw new Error('useApp must be used inside <StoreProvider>')
  return store
}
