import React, { useEffect, useState } from 'react';
import { CheckCircle2, Globe, Trash2, AlertTriangle, Wrench } from 'lucide-react';
import { PageHeader, Row, Section, Select } from './controls';
import { browserService } from '../../services/api';

const ACCESS = [
  { value: 'read', label: 'Read' },
  { value: 'write', label: 'Read and change' },
];

/**
 * Settings > Browser: whether the agent's browser can run here, the websites it may use
 * (read, or read and change), and the website tools it built.
 */
const BrowserPage = () => {
  const [status, setStatus] = useState(null);
  const [sites, setSites] = useState({});
  const [tools, setTools] = useState([]);
  const [error, setError] = useState(null);

  const load = async () => {
    try {
      const [s, list, built] = await Promise.all([browserService.status(), browserService.sites(), browserService.tools()]);
      setStatus(s);
      setSites(list);
      setTools(built);
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  };
  useEffect(() => { load(); }, []);

  const act = async (fn) => {
    setError(null);
    try { await fn(); } catch (e) { setError(e.message); }
    load();
  };

  return (
    <div>
      <PageHeader title="Browser"
        description="The agent can use websites you have no connector for. It asks before it uses a site and before any change, and asks you for logins, which are never saved." />
      {error && <p role="alert" className="mb-4 text-sm text-red-300">{error}</p>}

      <Section>
        {status && (status.available ? (
          <p className="flex items-center gap-2 py-3 text-sm text-gray-300"><CheckCircle2 size={16} className="text-green-300" />The browser is ready.</p>
        ) : (
          <p className="flex items-start gap-2 py-3 text-sm text-amber-200"><AlertTriangle size={16} className="mt-0.5 shrink-0" />{status.reason}</p>
        ))}
      </Section>

      <Section title="Websites">
        {Object.keys(sites).length === 0 ? (
          <p className="py-3 text-sm text-gray-500">No websites yet. The agent asks the first time it needs one.</p>
        ) : Object.entries(sites).map(([origin, access]) => (
          <Row key={origin} label={<span className="flex items-center gap-2"><Globe size={14} className="text-gray-400" />{origin}</span>}>
            <div className="flex items-center gap-2">
              <Select id={`site-${origin}`} label={`Access for ${origin}`} value={access} options={ACCESS}
                onChange={(value) => act(() => browserService.setSite(origin, value))} />
              <button type="button" aria-label={`Remove ${origin}`} onClick={() => act(() => browserService.removeSite(origin))}
                className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 hover:text-red-300"><Trash2 size={15} /></button>
            </div>
          </Row>
        ))}
      </Section>

      <Section title="Website tools">
        {tools.length === 0 ? (
          <p className="py-3 text-sm text-gray-500">None yet. When the agent uses a website, it saves a tool that runs again quickly.</p>
        ) : tools.map((tool) => (
          <Row key={tool.name}
            label={<span className="flex items-center gap-2"><Wrench size={14} className="text-gray-400" />{tool.name}
              <span className="text-xs text-gray-500">{tool.effect === 'write' ? 'changes the site' : 'reads'}</span></span>}
            description={`${tool.description || tool.task || ''} (${tool.url})`}>
            <button type="button" aria-label={`Delete ${tool.name}`} onClick={() => act(() => browserService.deleteTool(tool.name))}
              className="rounded-lg p-1.5 text-gray-400 hover:bg-white/5 hover:text-red-300"><Trash2 size={15} /></button>
          </Row>
        ))}
      </Section>
    </div>
  );
};

export default BrowserPage;
