import { useUi } from '../state/UiContext'

export function Toasts() {
  const { toasts, dismiss, announce } = useUi()
  return (
    <>
      <div className="toasts" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.tone ? `is-${t.tone}` : ''}`}>
            <span>{t.text}</span>
            {t.action && (
              <button
                type="button"
                onClick={() => {
                  t.action!.run()
                  dismiss(t.id)
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
      <p className="sr" aria-live="polite">
        {announce}
      </p>
    </>
  )
}
