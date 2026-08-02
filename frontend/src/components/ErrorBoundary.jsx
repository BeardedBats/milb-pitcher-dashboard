import React from "react";

// Catches render-time throws anywhere in the tree so a bad payload degrades
// to a reload prompt instead of a white screen.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("Render error:", error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div
        style={{
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          background: "var(--bg, #0b1120)",
          color: "var(--text, #e8eef7)",
          fontFamily: "'DM Sans', sans-serif",
          padding: 24,
          textAlign: "center",
        }}
      >
        <div style={{ fontSize: 20, fontWeight: 700 }}>Something went wrong.</div>
        <div style={{ color: "var(--text-dim, #8b9bb4)", fontSize: 14, maxWidth: 480 }}>
          {String(this.state.error?.message || this.state.error)}
        </div>
        <button
          onClick={() => window.location.reload()}
          style={{
            background: "#55e8ff",
            color: "#0b1120",
            border: "none",
            borderRadius: 8,
            padding: "10px 22px",
            fontWeight: 700,
            fontSize: 14,
            cursor: "pointer",
            fontFamily: "inherit",
          }}
        >
          Reload Dashboard
        </button>
      </div>
    );
  }
}
