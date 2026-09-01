import React, { useState } from 'react';
import { Mail } from 'lucide-react';
import { callApi } from '../utils/api';
import { useAuth } from '../context/AuthContext';
import { FuturisticButton } from './ui/FuturisticButton';
import { buildMailtoUrl, contractContactSubject, freelancerToClientBody, clientToFreelancerBody } from '../utils/mailto';

/**
 * [ Contact Client ] / [ Contact Freelancer ] — opens the viewer's own
 * default mail client via a `mailto:` link, prefilled from the same
 * assignment-details endpoint the Contract Details drawer already uses.
 * That endpoint is gated by contractPartyOnly (this contract's client, its
 * assigned freelancer, or admin) server-side, so the authorization for
 * "who is allowed to see this contact's email" is enforced exactly once,
 * on the backend — this component never decides that itself.
 *
 * viewerRole: the role of the person clicking this button. 'client' means
 * the button contacts the freelancer; 'freelancer' means it contacts the
 * client.
 */
export function ContactParticipantButton({ contractId, viewerRole, size = 'sm', variant = 'secondary', className }) {
  const { user } = useAuth();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const label = viewerRole === 'client' ? 'Contact Freelancer' : 'Contact Client';

  const handleClick = async () => {
    setLoading(true);
    setError('');
    try {
      const details = await callApi(`/api/contracts/${contractId}/assignment-details`);
      const contactingFreelancer = viewerRole === 'client';
      const toEmail = contactingFreelancer ? details.freelancerEmail : details.clientEmail;

      if (!toEmail) {
        setError(
          contactingFreelancer
            ? 'Freelancer contact information is currently unavailable.'
            : 'Client contact information is currently unavailable.',
        );
        return;
      }

      const body = contactingFreelancer
        ? clientToFreelancerBody({
            freelancerName: details.freelancerDisplayName,
            contractTitle: details.title,
            contractId,
            clientName: user?.displayName,
          })
        : freelancerToClientBody({
            clientName: details.clientDisplayName,
            contractTitle: details.title,
            contractId,
            freelancerName: user?.displayName,
          });

      window.location.href = buildMailtoUrl({
        to: toEmail,
        subject: contractContactSubject(contractId),
        body,
      });
    } catch (err) {
      setError(err.message || 'Unable to load contact information.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className={className}>
      <FuturisticButton
        variant={variant}
        size={size}
        icon={Mail}
        loading={loading}
        loadingText="Loading..."
        onClick={handleClick}
      >
        {label}
      </FuturisticButton>
      {error && <p className="mt-1.5 font-mono text-[11px] text-fail">{error}</p>}
    </div>
  );
}

export default ContactParticipantButton;
