
    -- The theme the terminal's process was started for, light or dark; NULL when none was
    -- named, which is drawn and reported as dark.
    ALTER TABLE terminals ADD COLUMN theme TEXT;
  