import { useState } from 'react';
import heroBg from '../../assets/hero_bg.png';
import macbookMockup from '../../assets/macbook_mockup.svg';
import Header from './Header';
import Chatbot from './Chatbot';
import '../../styles/landing_page/hero.css';

export default function Hero() {
  const [isChatbotOpen, setIsChatbotOpen] = useState(false);

  const _toggleChatbot = () => {
    setIsChatbotOpen(!isChatbotOpen);
  };
  return (
    <section className="hero-section">
      {/* Header positioned absolutely over the hero background */}
      <Header />

      {/* Subtle Background Pattern */}
      <div
        className="hero-background"
        style={{
          backgroundImage: `url(${heroBg})`
        }}
      ></div>

      {/* Hero Content */}
      <div className="hero-container">
        <div className="hero-content">
          {/* Main Heading with decorative elements */}
          <div className="hero-title-wrapper">
            <h1 className="hero-title">
              Smarter <span className="freight-border">
                {/* Stars positioned exactly on the border corners */}
                <span className="star star-top-left">✦</span>
                <span className="star star-top-right">✦</span>
                <span className="star star-bottom-left">✦</span>
                <span className="star star-bottom-right">✦</span>
                Freight
              </span>
              <br />
              <span>Management Starts Here</span>
            </h1>
          </div>

          {/* Subtitle */}
          <p className="hero-subtitle">
            AI-Powered Onboarding, GPS Tracking, Compliance, and Marketplace in One Platform
          </p>

          {/* CTA Buttons */}
          <div className="hero-cta-buttons">
            <button className="hero-primary-button">
              Start Free Trial
            </button>
            <button className="hero-secondary-button">
              Get Demo
            </button>
          </div>

          {/* MacBook Mockup */}
          <div className="hero-mockup-container">
            <div className="hero-mockup">
              <img 
                src={macbookMockup} 
                alt="FreightPower Dashboard on MacBook" 
                className="hero-mockup-image"
              />

              {/* Floating Chat/Support Bubble */}
              {/* <div className="hero-chat-bubble" onClick={toggleChatbot}>
                <img 
                  src={aiIcon} 
                  alt="AI Assistant" 
                  className="hero-chat-icon"
                />
              </div> */}
            </div>
          </div>
        </div>
      </div>

      {/* Chatbot Popup */}
      {/* {isChatbotOpen && (
        <Chatbot isOpen={isChatbotOpen} onClose={() => setIsChatbotOpen(false)} />
      )} */}
    </section>
  )
}