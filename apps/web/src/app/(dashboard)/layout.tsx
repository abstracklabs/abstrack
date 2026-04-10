import { Sidebar }              from '../../components/layout/Sidebar'
import { Topbar }               from '../../components/layout/Topbar'
import { AlertToastContainer }  from '../../components/live/AlertToast'

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-screen overflow-hidden bg-[var(--bg-base)]">
      <Sidebar />

      <div className="flex-1 flex flex-col ml-56 overflow-hidden">
        <Topbar />
        <main className="flex-1 overflow-y-auto p-6">
          {children}
        </main>
      </div>

      <AlertToastContainer />
    </div>
  )
}
