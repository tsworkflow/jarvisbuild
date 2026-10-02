-- Remediering del 2 (JARVIS-050/051/055): permanent enhetstilbakekalling,
-- bundne godkjenninger og EN aktiv sesjon per person.
--
-- 1. `devices.revoked_at`: en tilbakekalt enhet kan ALDRI autorisere på nytt. Før
--    denne migrasjonen fjernet `revoke_device` kun utestående grants - nøkkelen
--    sto fortsatt innrullert og kunne hente et nytt grant umiddelbart og signere
--    klasse D-godkjenninger videre. `revoked_device_keys` husker nøkkelens
--    fingerprint, slik at den samme nøkkelen heller ikke kan rulles inn igjen
--    under en NY device_id.
-- 2. `approvals`: engangs-noncen lagrer nå HVA godkjenningen var bundet til
--    (verktøy, parameter-hash, forespørrende person, godkjennende person,
--    utstedelsestidspunkt) - revisjon av et forbruk viser hele bindingen.
-- 3. `sessions_one_active_per_person_idx`: to samtidige første autorisasjoner
--    kunne lage to `active` sesjoner (`FOR UPDATE` på null rader låser ingenting).
--    Den delvise unike indeksen er den STRUKTURELLE garantien.

ALTER TABLE devices
  ADD COLUMN revoked_at timestamptz,
  ADD COLUMN revoked_key_fingerprint text,
  ADD COLUMN revoked_reason text;

-- Eldre konvensjon: `public_key_pem IS NULL` = tilbakekalt. Marker slike rader eksplisitt
-- (uten fingerprint - nøkkelen er allerede borte), slik at de heller ikke kan rulles inn igjen.
UPDATE devices SET revoked_at = now(), revoked_reason = 'legacy_null_key' WHERE public_key_pem IS NULL AND revoked_at IS NULL;

CREATE TABLE revoked_device_keys (
  tenant_id       text NOT NULL REFERENCES tenants (tenant_id),
  key_fingerprint text NOT NULL,
  device_id       text NOT NULL,
  revoked_at      timestamptz NOT NULL DEFAULT now(),
  reason          text,
  PRIMARY KEY (tenant_id, key_fingerprint)
);

-- Minst mulig rettigheter: INSERT/SELECT. ALDRI UPDATE/DELETE - en tilbakekalling er permanent.
GRANT SELECT, INSERT ON revoked_device_keys TO jarvis_app;
ALTER TABLE revoked_device_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE revoked_device_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY revoked_device_keys_tenant_isolation ON revoked_device_keys
  USING (tenant_id = current_setting('jarvis.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('jarvis.tenant_id', true));

ALTER TABLE approvals
  ADD COLUMN tool_id              text,
  ADD COLUMN parameters_hash      text,
  ADD COLUMN requester_person_id  text,
  ADD COLUMN approver_person_id   text,
  ADD COLUMN issued_at            timestamptz;

-- Rydd opp eventuelle eksisterende duplikater FØR den unike indeksen opprettes:
-- behold den sist aktive sesjonen per (tenant, person), lukk resten.
UPDATE sessions s SET status = 'closed'
 WHERE s.status = 'active'
   AND EXISTS (
     SELECT 1 FROM sessions s2
      WHERE s2.tenant_id = s.tenant_id AND s2.person_id = s.person_id AND s2.status = 'active'
        AND (s2.last_active_at, s2.session_id) > (s.last_active_at, s.session_id)
   );

CREATE UNIQUE INDEX sessions_one_active_per_person_idx
  ON sessions (tenant_id, person_id) WHERE status = 'active';
