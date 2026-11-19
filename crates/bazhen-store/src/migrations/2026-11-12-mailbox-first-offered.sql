
    ALTER TABLE mailbox ADD COLUMN first_offered_event_id INTEGER REFERENCES events (id);
  