import { useState, type ChangeEvent, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';

type Status = 'idle' | 'uploading' | 'transcoding' | 'completed' | 'failed';

interface Video {
  id: string;
  originalFileName: string;
  cloudfrontUrl: string;
  status: string;
  createdAt: string;
}

// Map backend statuses to human-friendly stage labels
const STAGE_LABELS: Record<string, string> = {
  PENDING: "Preparing upload...",
  QUEUED: "Queued for processing...",
  PROCESSING: "Transcoding in progress...",
  COMPLETED: "Transcoding complete!",
  FAILED: "Transcoding failed"
};

export default function TranscodingVideo() {
  const navigate = useNavigate();
  const [file, setFile] = useState<File | null>(null);
  const [videoUrl, setVideoUrl] = useState<string>("");
  const [status, setStatus] = useState<Status>('idle');
  const [videos, setVideos] = useState<Video[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(true);
  const [user, setUser] = useState<{ email: string } | null>(null);
  const [jobId, setJobId] = useState<string>("");
  const [stage, setStage] = useState<string>("");
  const [progress, setProgress] = useState<number>(0);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pollTimerRef = useRef<number | null>(null);

  const BACKEND_URL = "https://bc1opubda1.execute-api.us-east-1.amazonaws.com/upload";

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      navigate('/login');
      return;
    }
    
    const userData = localStorage.getItem('user');
    if (userData) {
      setUser(JSON.parse(userData));
    }

    fetchHistory();

    // Cleanup polling on unmount
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
    };
  }, [navigate]);

  const fetchHistory = async () => {
    try {
      const token = localStorage.getItem('token');
      const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';
      const response = await fetch(`${backendUrl}/api/videos`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await response.json();
      if (response.ok) {
        setVideos(data.videos || []);
      }
    } catch (err) {
      console.error("Failed to fetch history:", err);
    } finally {
      setLoadingHistory(false);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    navigate('/login');
  };

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
      setErrorMsg("");
    }
  };

  // ── Poll job status from DynamoDB via auth-backend ──
  const startPolling = useCallback((currentJobId: string) => {
    const backendUrl = import.meta.env.VITE_BACKEND_URL || 'http://localhost:3001';

    pollTimerRef.current = window.setInterval(async () => {
      try {
        const response = await fetch(`${backendUrl}/api/status/${currentJobId}`);
        const data = await response.json();

        if (!response.ok) {
          console.error("Status poll error:", data);
          return;
        }

        setStage(data.stage || STAGE_LABELS[data.status] || "Processing...");
        setProgress(data.progress || 0);

        if (data.status === "COMPLETED") {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          setVideoUrl(data.cloudfrontUrl || "");
          setStatus('completed');

          // Save metadata to auth-backend
          const token = localStorage.getItem('token');
          if (token && file) {
            try {
              await fetch(`${backendUrl}/api/videos`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({
                  originalFileName: file.name,
                  originalFileSize: file.size,
                  cloudfrontUrl: data.cloudfrontUrl,
                  status: 'completed'
                })
              });
            } catch (saveErr) {
              console.error("Failed to save video metadata:", saveErr);
            }
          }
          fetchHistory();
        }

        if (data.status === "FAILED") {
          if (pollTimerRef.current) clearInterval(pollTimerRef.current);
          setStatus('failed');
          setErrorMsg(data.error || "Transcoding failed. Please try again.");
        }

      } catch (err) {
        console.error("Polling error:", err);
      }
    }, 3000);  // Poll every 3 seconds
  }, [file]);

  const uploadToS3 = async () => {
    if (!file) return;
    setStatus('uploading');
    setProgress(0);
    setStage("Requesting upload URL...");
    setErrorMsg("");

    try {
      // ── Step 1: Get presigned URL + jobId ──
      const response = await fetch(BACKEND_URL, {
        method: "POST",
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fileName: file.name, contentType: file.type })
      });

      // ── Handle rate limiting ──
      if (response.status === 429) {
        const data = await response.json();
        setStatus('idle');
        setErrorMsg(`Too many uploads. Please wait ${data.retryAfter || 60} seconds before trying again.`);
        return;
      }

      const { uploadUrl, key, jobId: returnedJobId } = await response.json();
      setJobId(returnedJobId);

      // ── Step 2: Upload directly to S3 ──
      setStage("Uploading to S3...");
      setProgress(5);

      const s3Response = await fetch(uploadUrl, {
        method: 'PUT',
        body: file,
        headers: { "Content-Type": file.type }
      });

      if (s3Response.ok) {
        // ── Step 3: Start polling for real transcoding status ──
        setStatus('transcoding');
        setStage("Upload complete — queued for transcoding");
        setProgress(10);
        startPolling(returnedJobId);
      } else {
        throw new Error("S3 upload failed");
      }

    } catch (err) {
      console.error("Upload failed:", err);
      setStatus('idle');
      setErrorMsg("Upload failed. Please try again.");
    }
  };

  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [isCollapsed, setIsCollapsed] = useState(false);

  return (
    <div className={`${isSidebarOpen ? 'sidebar-open' : ''} ${isCollapsed ? 'collapsed' : ''}`} style={{ display: 'flex', minHeight: '100vh', width: '100%', background: '#fff', color: '#000', fontFamily: "'Inter', sans-serif" }}>
      {/* MOBILE TOGGLE */}
      <button 
        className="mobile-nav-toggle"
        onClick={() => setIsSidebarOpen(!isSidebarOpen)}
      >
        {isSidebarOpen ? '✕' : '☰'}
      </button>

      {/* SIDEBAR */}
      <aside className={`sidebar-fixed ${isCollapsed ? 'collapsed' : ''}`} style={{ borderRight: '1px solid #e0e0e0', display: 'flex', flexDirection: 'column', background: '#fff' }}>
        <div className="center-on-collapse" style={{ padding: '1rem', borderBottom: '1px solid #e0e0e0', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div 
            onClick={() => { navigate('/transcode'); setIsSidebarOpen(false); }}
            style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}
          >
            <span style={{ fontSize: '1.2rem', color: '#4f46e5' }}>▶</span>
            <span className="hide-on-collapse" style={{ fontWeight: 800, fontSize: '1rem' }}>Zylar</span>
          </div>
          <span 
            onClick={() => {
              if (window.innerWidth <= 768) {
                setIsSidebarOpen(false);
              } else {
                setIsCollapsed(!isCollapsed);
              }
            }}
            style={{ color: '#000', cursor: 'pointer', fontWeight: 300, fontSize: '1.2rem', padding: '0 0.5rem' }}
          >
            {isCollapsed ? '»' : '«'}
          </span>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: isCollapsed ? '1.5rem 0.5rem' : '1.5rem 1rem' }}>
          <h3 className="hide-on-collapse" style={{ fontSize: '0.9rem', fontWeight: 800, marginBottom: '1.5rem', color: '#000' }}>Projects</h3>
          
          {loadingHistory ? (
            <div style={{ color: '#999', fontSize: '0.8rem', textAlign: 'center' }}>{isCollapsed ? '...' : 'Loading...'}</div>
          ) : videos.length === 0 ? (
            <div className="hide-on-collapse" style={{ color: '#999', fontSize: '0.8rem' }}>No projects yet.</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
              {videos.map(video => (
                <div 
                  key={video.id} 
                  style={{ 
                    padding: isCollapsed ? '0.75rem 0.25rem' : '1rem', 
                    border: '1px solid #e0e0e0', 
                    borderRadius: '8px', 
                    cursor: 'pointer', 
                    background: '#fff',
                    textAlign: isCollapsed ? 'center' : 'left'
                  }}
                  onClick={() => { navigate('/dashboard'); setIsSidebarOpen(false); }}
                  title={video.originalFileName}
                >
                  {isCollapsed ? (
                    <span style={{ fontSize: '1rem' }}>📄</span>
                  ) : (
                    <>
                      <div style={{ fontWeight: 800, fontSize: '0.85rem', marginBottom: '0.25rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                        {video.originalFileName}
                      </div>
                      <div style={{ fontSize: '0.7rem', color: '#999' }}>
                        {new Date(video.createdAt).toLocaleDateString()}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="center-on-collapse" style={{ padding: '1rem', borderTop: '1px solid #e0e0e0' }}>
          <div className="hide-on-collapse" style={{ fontSize: '0.75rem', fontWeight: 800, marginBottom: '1rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: '#000' }}>
            {user?.email || 'user@example.com'}
          </div>
          <div style={{ display: 'flex' }}>
            <button 
              onClick={handleLogout}
              style={{ 
                flex: 1, 
                padding: '0.6rem', 
                background: '#fff', 
                border: '1px solid #e0e0e0', 
                fontSize: '0.75rem', 
                fontWeight: 800, 
                cursor: 'pointer',
                minWidth: isCollapsed ? '40px' : 'auto'
              }}
            >
              {isCollapsed ? '➡' : 'Sign out'}
            </button>
          </div>
        </div>
      </aside>

      {/* MAIN CONTENT AREA */}
      <main className={`main-with-sidebar ${isCollapsed ? 'collapsed' : ''}`} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', background: '#fff', padding: '2rem' }}>


        <div style={{ textAlign: 'center', maxWidth: '600px', width: '100%' }}>
          <h1 style={{ fontSize: '2.5rem', fontWeight: 800, marginBottom: '1rem', color: '#000', letterSpacing: '-0.02em' }}>
            What do you want to transcode?
          </h1>
          <p style={{ fontSize: '1.1rem', color: '#666', marginBottom: '3rem' }}>
            Upload a video file to generate a high-performance adaptive HLS stream instantly.
          </p>

          <div style={{ width: '100%', maxWidth: '500px', margin: '0 auto', border: '1px solid #e0e0e0', padding: '3rem', background: '#fff' }}>
            {status === 'idle' && (
              <>
                {/* Error message */}
                {errorMsg && (
                  <div style={{ marginBottom: '1.5rem', padding: '1rem', background: '#fef2f2', borderLeft: '4px solid #ef4444', fontSize: '0.85rem', color: '#991b1b', textAlign: 'left' }}>
                    {errorMsg}
                  </div>
                )}

                <div 
                  onClick={() => fileInputRef.current?.click()}
                  style={{ border: '1px solid #e0e0e0', padding: '1rem', marginBottom: '1.5rem', textAlign: 'center', cursor: 'pointer', background: '#f9f9f9', color: file ? '#000' : '#999', fontSize: '0.9rem' }}
                >
                  {file ? file.name : "Choose video file..."}
                  <input type="file" ref={fileInputRef} onChange={handleFileChange} style={{ display: 'none' }} accept="video/*" />
                </div>

                <button 
                  onClick={uploadToS3} 
                  disabled={!file}
                  style={{ width: '100%', padding: '1rem', background: '#808080', color: '#fff', border: 'none', fontWeight: 800, fontSize: '1rem', cursor: file ? 'pointer' : 'not-allowed' }}
                >
                  Start Transcoding
                </button>
              </>
            )}

            {status === 'failed' && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>⚠️</div>
                <h2 style={{ fontWeight: 800, fontSize: '1.5rem', marginBottom: '1rem', color: '#dc2626' }}>
                  Transcoding Failed
                </h2>
                <p style={{ fontSize: '0.9rem', color: '#666', marginBottom: '2rem' }}>{errorMsg}</p>
                <button 
                  onClick={() => { setFile(null); setStatus('idle'); setErrorMsg(""); setProgress(0); setStage(""); }}
                  style={{ width: '100%', padding: '1rem', background: '#000', color: '#fff', border: 'none', fontWeight: 800, cursor: 'pointer', fontSize: '0.9rem' }}
                >
                  Try Again
                </button>
              </div>
            )}

            {(status === 'uploading' || status === 'transcoding') && (
              <div style={{ textAlign: 'center' }}>
                <h2 style={{ fontWeight: 800, fontSize: '1.5rem', marginBottom: '0.5rem', color: '#000' }}>
                  {status === 'uploading' ? "Uploading..." : "Transcoding..."}
                </h2>
                
                {/* Real stage info */}
                <p style={{ fontSize: '0.85rem', color: '#666', marginBottom: '1.5rem' }}>
                  {stage}
                </p>

                {/* Progress bar */}
                <div style={{ width: '100%', height: '8px', background: '#e0e0e0', borderRadius: '4px', overflow: 'hidden', marginBottom: '0.5rem' }}>
                  <div style={{ 
                    width: `${progress}%`, 
                    height: '100%', 
                    background: 'linear-gradient(90deg, #4f46e5, #7c3aed)',
                    borderRadius: '4px',
                    transition: 'width 0.5s ease'
                  }} />
                </div>
                <p style={{ fontSize: '0.75rem', color: '#999' }}>{progress}%</p>

                {/* Spinner */}
                <div style={{ width: '40px', height: '40px', border: '4px solid #f3f3f3', borderTop: '4px solid #000', borderRadius: '50%', animation: 'spin 1s linear infinite', margin: '1.5rem auto 0' }} />

                {jobId && (
                  <p style={{ fontSize: '0.7rem', color: '#ccc', marginTop: '1rem', fontFamily: 'monospace' }}>
                    Job: {jobId.slice(0, 8)}...
                  </p>
                )}
              </div>
            )}

            {status === 'completed' && (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>✅</div>
                <h2 style={{ fontWeight: 800, fontSize: '1.5rem', marginBottom: '2rem', color: '#000' }}>
                  Success!
                </h2>
                <div style={{ textAlign: 'left' }}>
                  <p style={{ fontWeight: 800, fontSize: '0.7rem', color: '#999', textTransform: 'uppercase', marginBottom: '0.5rem' }}>CloudFront Link</p>
                  <div style={{ display: 'flex', border: '1px solid #e0e0e0', padding: '0.25rem', background: '#fff' }}>
                    <input readOnly value={videoUrl} style={{ flex: 1, border: 'none', background: 'none', padding: '0.5rem', fontFamily: 'monospace', fontSize: '0.8rem', color: '#000' }} />
                    <button 
                      onClick={() => { navigator.clipboard.writeText(videoUrl); alert('Copied!'); }} 
                      style={{ background: '#000', color: '#fff', border: 'none', padding: '0.5rem 1rem', fontWeight: 800, cursor: 'pointer', fontSize: '0.8rem' }}
                    >
                      Copy
                    </button>
                  </div>

                  <button 
                    onClick={() => { setFile(null); setStatus('idle'); setJobId(""); setProgress(0); setStage(""); setVideoUrl(""); }}
                    style={{ marginTop: '2.5rem', width: '100%', padding: '1rem', background: '#fff', border: '1px solid #e0e0e0', fontWeight: 800, cursor: 'pointer', fontSize: '0.9rem', color: '#000' }}
                  >
                    New Transcode
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      </main>
      
      <style>{`
        @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}
