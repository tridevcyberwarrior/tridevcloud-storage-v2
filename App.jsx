import { useState, useEffect } from 'react';
import './App.css';

function App() {
  const [loggedIn, setLoggedIn] = useState(false);
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [requestId, setRequestId] = useState(null);
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [user, setUser] = useState(null);

  // Check if already logged in
  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      const res = await fetch('/auth/me', { credentials: 'include' });
      const data = await res.json();
      if (data.loggedIn) {
        setLoggedIn(true);
        setUser(data.user);
        loadFiles();
      }
    } catch (err) {
      console.log('Not logged in');
    }
  };

  const loadFiles = async () => {
    try {
      const res = await fetch('/files', { credentials: 'include' });
      const data = await res.json();
      setFiles(data.files || []);
    } catch (err) {
      console.error('Error loading files:', err);
    }
  };

  const sendCode = async () => {
    try {
      const res = await fetch('/auth/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone })
      });
      const data = await res.json();
      if (data.requestId) {
        setRequestId(data.requestId);
        alert('Code aapke Telegram pe bheja gaya hai!');
      } else {
        alert('Error: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };

  const verifyCode = async () => {
    try {
      const res = await fetch('/auth/verify-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ requestId, code })
      });
      const data = await res.json();
      if (data.success) {
        alert('Login successful!');
        setLoggedIn(true);
        loadFiles();
      } else {
        alert('Error: ' + (data.error || 'Verification failed'));
      }
    } catch (err) {
      alert('Error: ' + err.message);
    }
  };

  const handleUpload = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    setUploading(true);
    const formData = new FormData();
    formData.append('file', file);

    try {
      const res = await fetch('/files/upload', {
        method: 'POST',
        credentials: 'include',
        body: formData
      });
      const data = await res.json();
      if (data.success) {
        alert('File uploaded successfully!');
        loadFiles();
      } else {
        alert('Upload failed: ' + (data.error || 'Unknown error'));
      }
    } catch (err) {
      alert('Upload error: ' + err.message);
    } finally {
      setUploading(false);
    }
  };

  const deleteFile = async (fileId) => {
    if (!confirm('Delete this file?')) return;
    
    try {
      const res = await fetch(`/files/${fileId}`, {
        method: 'DELETE',
        credentials: 'include'
      });
      if (res.ok) {
        loadFiles();
      }
    } catch (err) {
      alert('Delete error: ' + err.message);
    }
  };

  const logout = async () => {
    await fetch('/auth/logout', { 
      method: 'POST',
      credentials: 'include'
    });
    setLoggedIn(false);
    setFiles([]);
    setUser(null);
  };

  const formatSize = (bytes) => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  if (!loggedIn) {
    return (
      <div className="login-container">
        <h1>☁️ My Cloud Storage</h1>
        <p>Apne Telegram account se login karo</p>
        
        {!requestId ? (
          <div className="login-form">
            <input
              type="text"
              placeholder="+919876543210"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
            />
            <button onClick={sendCode}>Send Code</button>
          </div>
        ) : (
          <div className="login-form">
            <p>Code bheja gaya: {phone}</p>
            <input
              type="text"
              placeholder="Enter code"
              value={code}
              onChange={(e) => setCode(e.target.value)}
            />
            <button onClick={verifyCode}>Verify</button>
            <button onClick={() => setRequestId(null)} className="secondary">Back</button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="app-container">
      <header>
        <h1>☁️ My Cloud Storage</h1>
        <div className="user-info">
          <span>{user?.phone}</span>
          <button onClick={logout}>Logout</button>
        </div>
      </header>

      <div className="upload-section">
        <h2>Upload File</h2>
        <input 
          type="file" 
          onChange={handleUpload}
          disabled={uploading}
        />
        {uploading && <p>Uploading...</p>}
      </div>

      <div className="files-section">
        <h2>My Files ({files.length})</h2>
        {files.length === 0 ? (
          <p>No files uploaded yet.</p>
        ) : (
          <div className="file-list">
            {files.map(file => (
              <div key={file.id} className="file-item">
                <div className="file-info">
                  <h3>{file.filename}</h3>
                  <p>{formatSize(file.size)} • {file.mimetype}</p>
                </div>
                <div className="file-actions">
                  <a 
                    href={`/files/${file.id}/stream`} 
                    target="_blank"
                    className="btn-view"
                  >
                    View/Download
                  </a>
                  <button 
                    onClick={() => deleteFile(file.id)}
                    className="btn-delete"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;