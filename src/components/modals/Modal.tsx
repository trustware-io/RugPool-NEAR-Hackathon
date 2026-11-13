import { useEffect, useRef, type ReactNode } from 'react'

/** Native <dialog>: focus trap, Esc and the top layer come from the browser. */
export function Modal({ title, sub, onClose, children }: { title: string; sub?: ReactNode; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null)
  const close = useRef(onClose)
  close.current = onClose

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (!d.open) d.showModal()
    // The wallet connector's popup is a plain fixed element. A modal <dialog> sits above it
    // in the top layer and makes it inert, so step out of modal mode while it is open.
    const syncWithWallet = () => {
      const walletOpen = document.querySelector('.hot-connector-popup') !== null
      if (walletOpen && d.matches(':modal')) {
        d.close()
        d.show()
      } else if (!walletOpen && d.open && !d.matches(':modal')) {
        d.close()
        d.showModal()
      }
    }
    const observer = new MutationObserver(syncWithWallet)
    observer.observe(document.body, { childList: true })
    syncWithWallet()
    const onCancel = (e: Event) => {
      e.preventDefault()
      close.current()
    }
    d.addEventListener('cancel', onCancel)
    return () => {
      observer.disconnect()
      d.removeEventListener('cancel', onCancel)
      if (d.open) d.close()
    }
  }, [])

  return (
    <dialog ref={ref} className="modal" aria-labelledby="m-title" onClick={(e) => e.target === ref.current && close.current()}>
      <div className="modal-in">
        <div className="modal-head">
          <h2 id="m-title">{title}</h2>
          <button type="button" className="x" onClick={() => close.current()}>
            <span aria-hidden="true">✕</span>
            <span className="sr">Close</span>
          </button>
        </div>
        {sub && <p className="sub">{sub}</p>}
        {children}
      </div>
    </dialog>
  )
}
