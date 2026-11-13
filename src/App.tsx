import { useEffect } from 'react'
import { AutoDefendCard } from './components/AutoDefendCard'
import { ChallengeCard } from './components/ChallengeCard'
import { CourtPanel } from './components/CourtPanel'
import { Effects } from './components/Effects'
import { Footer } from './components/Footer'
import { Header } from './components/Header'
import { Leaderboard } from './components/Leaderboard'
import { LiveFeed } from './components/LiveFeed'
import { AutoDefendModal } from './components/modals/AutoDefendModal'
import { ChallengeModal } from './components/modals/ChallengeModal'
import { ConnectModal } from './components/modals/ConnectModal'
import { DepositModal } from './components/modals/DepositModal'
import { WithdrawModal } from './components/modals/WithdrawModal'
import { PriceCurve } from './components/PriceCurve'
import { RoundHero } from './components/RoundHero'
import { Ticker } from './components/Ticker'
import { Toasts } from './components/Toasts'
import { DepositProvider } from './state/DepositContext'
import { phaseOf } from './state/derive'
import { GameProvider, useGame } from './state/GameContext'
import { deposits, store } from './state/services'
import { UiProvider, useUi } from './state/UiContext'

function Modals() {
  const { modal } = useUi()
  switch (modal?.kind) {
    case 'deposit':
      return <DepositModal key={modal.target} target={modal.target} />
    case 'challenge':
      return <ChallengeModal />
    case 'auto':
      return <AutoDefendModal />
    case 'withdraw':
      return <WithdrawModal />
    case 'connect':
      return store.emailSignIn ? <ConnectModal email={store.emailSignIn} /> : null
    default:
      return null
  }
}

function Shell() {
  const { state, now } = useGame()
  const phase = state ? phaseOf(state, now) : 'open'

  // The showdown theme flips page tokens on <html>, so the whole viewport goes into alarm.
  useEffect(() => {
    document.documentElement.dataset.phase = phase
  }, [phase])

  if (!state) {
    return (
      <div className="loading" role="status">
        Loading the throne room…
      </div>
    )
  }
  return (
    <div className="app">
      <Header />
      <Ticker />
      <main className="layout">
        <div className="col-main">
          <RoundHero />
          <ChallengeCard />
          <PriceCurve />
          <AutoDefendCard />
        </div>
        <aside className="col-side" aria-label="Court and activity">
          <CourtPanel />
          <LiveFeed />
          <Leaderboard />
        </aside>
      </main>
      <Footer />
      <Modals />
      <Effects />
      <Toasts />
    </div>
  )
}

export function App() {
  return (
    <UiProvider>
      <GameProvider store={store}>
        <DepositProvider service={deposits}>
          <Shell />
        </DepositProvider>
      </GameProvider>
    </UiProvider>
  )
}
