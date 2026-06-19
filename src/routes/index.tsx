import { createFileRoute } from '@tanstack/react-router'
import { OutlineEditor } from '../components/OutlineEditor'

export const Route = createFileRoute('/')({
  component: HomePage,
})

function HomePage() {
  return (
    <main className="app">
      <header className="app-header">
        <h1>Workflowy OSS</h1>
        <p className="subtitle">
          An open-source, local-first outline. Your data lives in this browser.
        </p>
      </header>
      <OutlineEditor />
    </main>
  )
}
