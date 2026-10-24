import { Code } from '@src/repl/components/Code';
import Loader from '@src/repl/components/Loader';
import { BottomPanel, MainPanel, RightPanel } from '@src/repl/components/panel/Panel';
import UserFacingErrorMessage from '@src/repl/components/UserFacingErrorMessage';
import { useSettings } from '@src/settings.mjs';
import { TrackTabs } from '@src/repl/tracks/TrackTabs';

const DESKTOP = typeof window !== 'undefined' && window.tourbillon?.desktop;

// type Props = {
//  context: replcontext,
// }

export default function ReplEditor(Props) {
  const { context, ...editorProps } = Props;
  const { containerRef, editorRef, error, init, pending } = context;
  const settings = useSettings();
  const { panelPosition, isZen } = settings;
  const isEmbedded = typeof window !== 'undefined' && window.location !== window.parent.location;

  return (
    <div className="h-full flex flex-col relative" {...editorProps}>
      <Loader active={pending} />
      <div className="flex flex-col grow overflow-hidden">
        {/* <MainPanel context={context} isEmbedded={isEmbedded} className="hidden sm:block" /> */}
        <MainPanel context={context} isEmbedded={isEmbedded} />
        <div className="flex overflow-hidden h-full">
          <div className="flex flex-col grow min-w-0 overflow-hidden">
            {DESKTOP && !isZen && <TrackTabs />}
            <Code containerRef={containerRef} editorRef={editorRef} init={init} />
          </div>
          {!isZen && panelPosition === 'right' && <RightPanel context={context} />}
        </div>
      </div>
      <UserFacingErrorMessage error={error} />
      {!isZen && panelPosition === 'bottom' && <BottomPanel context={context} />}
      {/* <MainPanel context={context} isEmbedded={isEmbedded} className="block sm:hidden" /> */}
    </div>
  );
}
