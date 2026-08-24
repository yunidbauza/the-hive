import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { OptionStepper } from '@features/sessions/components/option-stepper';

const OPTIONS = ['low', 'medium', 'high', 'max'] as const;

const renderStepper = (value: (typeof OPTIONS)[number] = 'high') => {
  const onChange = vi.fn();
  render(
    <OptionStepper
      label="thinking effort"
      options={OPTIONS}
      value={value}
      onChange={onChange}
    />,
  );
  return { onChange };
};

const radio = (name: string) => screen.getByRole('radio', { name });

/**
 * The picker's bespoke stepper (story 044).
 *
 * `role="radio"` promises a keyboard contract — arrow keys move the selection,
 * the group is one tab stop. These tests exist because announcing that contract
 * without honouring it is worse than using plain buttons.
 */
describe('OptionStepper', () => {
  it('exposes the options as one named radio group', () => {
    renderStepper();

    expect(
      screen.getByRole('radiogroup', { name: 'thinking effort' }),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(OPTIONS.length);
  });

  it('marks only the current value as checked', () => {
    renderStepper('high');

    expect(radio('high')).toBeChecked();
    expect(radio('low')).not.toBeChecked();
  });

  it('selects on click', async () => {
    const user = userEvent.setup();
    const { onChange } = renderStepper('high');

    await user.click(radio('low'));

    expect(onChange).toHaveBeenCalledWith('low');
  });

  describe('the keyboard contract', () => {
    it('is a single tab stop, not one per option', async () => {
      const user = userEvent.setup();
      renderStepper('high');

      await user.tab();

      // Roving tabindex: two steppers would otherwise cost eight tab presses
      // to walk past, contradicting the grouping the role announces.
      expect(radio('high')).toHaveFocus();
      expect(radio('low')).toHaveAttribute('tabindex', '-1');
    });

    it('steps forward with ArrowRight and ArrowDown', async () => {
      const user = userEvent.setup();
      const { onChange } = renderStepper('high');
      radio('high').focus();

      await user.keyboard('{ArrowRight}');
      expect(onChange).toHaveBeenLastCalledWith('max');

      await user.keyboard('{ArrowDown}');
      expect(onChange).toHaveBeenLastCalledWith('max');
    });

    it('steps backward with ArrowLeft and ArrowUp', async () => {
      const user = userEvent.setup();
      const { onChange } = renderStepper('high');
      radio('high').focus();

      await user.keyboard('{ArrowLeft}');
      expect(onChange).toHaveBeenLastCalledWith('medium');

      await user.keyboard('{ArrowUp}');
      expect(onChange).toHaveBeenLastCalledWith('medium');
    });

    it('clamps at both ends rather than wrapping', async () => {
      const user = userEvent.setup();
      const { onChange } = renderStepper('low');
      radio('low').focus();

      await user.keyboard('{ArrowLeft}');

      // The fill is a scale: running off one end to reappear at the other
      // would read as the value jumping.
      expect(onChange).not.toHaveBeenCalled();
    });

    it('does not step on keys that are not arrows', async () => {
      const user = userEvent.setup();
      const { onChange } = renderStepper('high');
      radio('high').focus();

      await user.keyboard('x');

      // Enter and Space are deliberately not tested here: they activate the
      // focused button, which is the correct selection gesture for a radio and
      // is the browser's job rather than this component's.
      expect(onChange).not.toHaveBeenCalled();
    });
  });

  it('survives a value that is not in the option list', () => {
    // Defensive: `indexOf` returns -1, which would otherwise place the fill off
    // the track entirely.
    const onChange = vi.fn();
    render(
      <OptionStepper
        label="model"
        options={OPTIONS}
        value={'nonsense' as (typeof OPTIONS)[number]}
        onChange={onChange}
      />,
    );

    expect(screen.getAllByRole('radio')).toHaveLength(OPTIONS.length);
    expect(screen.queryByRole('radio', { checked: true })).not.toBeInTheDocument();
  });
  /**
   * A whole scale can stop applying (HIVE-100).
   *
   * Not the same as "this option is unavailable": a stepper is one value on a
   * scale, and there is no coherent way to grey out part of one — the fill would
   * still run to a dot nobody can pick. So it disables whole, and says why.
   */
  describe('when the scale does not apply', () => {
    it('refuses a click', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <OptionStepper
          label="thinking effort"
          options={['low', 'high'] as const}
          value="low"
          onChange={onChange}
          disabled
        />,
      );

      await user.click(screen.getByRole('radio', { name: 'high' }));

      expect(onChange).not.toHaveBeenCalled();
    });

    it('refuses the arrow keys too', () => {
      const onChange = vi.fn();
      render(
        <OptionStepper
          label="thinking effort"
          options={['low', 'high'] as const}
          value="low"
          onChange={onChange}
          disabled
        />,
      );

      fireEvent.keyDown(screen.getByRole('radio', { name: 'low' }), {
        key: 'ArrowRight',
      });

      expect(onChange).not.toHaveBeenCalled();
    });

    /**
     * Announced as well as faded. Opacity is no signal to a screen reader, and
     * disabling only the buttons would leave the *group* claiming to be
     * operable.
     */
    it('says so on the group, and gives the reason', () => {
      render(
        <OptionStepper
          label="thinking effort"
          options={['low', 'high'] as const}
          value="low"
          onChange={() => {}}
          disabled
          disabledReason="haiku does not think"
        />,
      );

      const group = screen.getByRole('radiogroup', {
        name: /thinking effort — haiku does not think/,
      });
      expect(group).toHaveAttribute('aria-disabled', 'true');
      expect(screen.getByText(/haiku does not think/)).toBeInTheDocument();
    });

    it('takes the group out of the tab order entirely', () => {
      render(
        <OptionStepper
          label="thinking effort"
          options={['low', 'high'] as const}
          value="low"
          onChange={() => {}}
          disabled
        />,
      );

      // The selected dot is the group's single tab stop when it is live.
      expect(screen.getByRole('radio', { name: 'low' })).toHaveAttribute(
        'tabindex',
        '-1',
      );
    });

    it('is fully operable again once it applies', async () => {
      const user = userEvent.setup();
      const onChange = vi.fn();
      render(
        <OptionStepper
          label="thinking effort"
          options={['low', 'high'] as const}
          value="low"
          onChange={onChange}
        />,
      );

      await user.click(screen.getByRole('radio', { name: 'high' }));

      expect(onChange).toHaveBeenCalledWith('high');
    });
  });
});
