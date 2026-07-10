import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ModelInfoDto, SettingsDto } from "@chamfer/shared";
import { SettingsModal } from "./SettingsModal";
import * as rest from "@/api/rest";

vi.mock("@/api/rest");

const mockedRest = vi.mocked(rest);

const SETTINGS: SettingsDto = {
  anthropicApiKey: "***abcd",
  anthropicBaseUrl: "https://anthropic.example/v1",
  openaiApiKey: "***wxyz",
  googleApiKey: "",
  modelJson: JSON.stringify({ id: "claude-opus-4" }),
};

const MODELS: ModelInfoDto[] = [
  {
    provider: "anthropic",
    id: "claude-opus-4",
    name: "Claude Opus 4",
    modelJson: JSON.stringify({ id: "claude-opus-4", baseUrl: "https://api.anthropic.com" }),
  },
  {
    provider: "anthropic",
    id: "claude-sonnet-4",
    name: "Claude Sonnet 4",
    modelJson: JSON.stringify({ id: "claude-sonnet-4", baseUrl: "https://api.anthropic.com" }),
  },
  {
    provider: "openai",
    id: "gpt-5",
    name: "GPT-5",
    modelJson: JSON.stringify({ id: "gpt-5", baseUrl: "https://api.openai.com/v1" }),
  },
  {
    provider: "google",
    id: "gemini-3",
    name: "Gemini 3",
    modelJson: JSON.stringify({ id: "gemini-3", baseUrl: "https://generativelanguage.googleapis.com/v1beta" }),
  },
];

describe("SettingsModal", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockedRest.getSettings.mockResolvedValue({ ...SETTINGS });
    mockedRest.getModels.mockResolvedValue(MODELS);
    mockedRest.putSettings.mockResolvedValue(undefined);
  });

  it("shows the selected provider's credentials and model", async () => {
    render(<SettingsModal open onOpenChange={() => {}} />);

    await waitFor(() => expect(mockedRest.getSettings).toHaveBeenCalled());
    expect(mockedRest.getModels).toHaveBeenCalled();

    const providerSelect = await screen.findByRole("combobox", { name: "Provider" });
    const apiKeyInput = screen.getByLabelText("API key") as HTMLInputElement;
    const baseUrlInput = screen.getByLabelText("Base URL") as HTMLInputElement;

    expect(providerSelect.textContent).toContain("Anthropic");
    expect(apiKeyInput.value).toBe("***abcd");
    expect(baseUrlInput.value).toBe("https://anthropic.example/v1");
    expect(await screen.findByText("Claude Opus 4")).toBeTruthy();
  });

  it("switches provider fields and saves its key, base URL, and model", async () => {
    render(<SettingsModal open onOpenChange={() => {}} />);

    const providerSelect = await screen.findByRole("combobox", { name: "Provider" });
    fireEvent.click(providerSelect);
    fireEvent.click(await screen.findByRole("option", { name: "OpenAI" }));

    const apiKeyInput = screen.getByLabelText("API key") as HTMLInputElement;
    const baseUrlInput = screen.getByLabelText("Base URL") as HTMLInputElement;
    expect(apiKeyInput.value).toBe("***wxyz");
    fireEvent.change(apiKeyInput, { target: { value: "sk-oai-newkey" } });
    fireEvent.change(baseUrlInput, { target: { value: "https://gateway.example/v1" } });

    const saveButton = screen.getByRole("button", { name: /save/i });
    fireEvent.click(saveButton);

    await waitFor(() => expect(mockedRest.putSettings).toHaveBeenCalled());

    const [patch] = mockedRest.putSettings.mock.calls[0] ?? [];
    expect(patch).toEqual({
      openaiApiKey: "sk-oai-newkey",
      openaiBaseUrl: "https://gateway.example/v1",
      modelJson: JSON.stringify({ id: "gpt-5", baseUrl: "https://api.openai.com/v1" }),
    });
  });

  it("shows inline error text when save fails", async () => {
    mockedRest.putSettings.mockRejectedValue(new Error("boom"));
    render(<SettingsModal open onOpenChange={() => {}} />);

    await screen.findByLabelText("API key");
    const saveButton = screen.getByRole("button", { name: /save/i });
    fireEvent.click(saveButton);

    expect(await screen.findByText(/boom/i)).toBeTruthy();
  });

  it("invokes onSaved after a successful save so settings-gated UI can refresh", async () => {
    const onSaved = vi.fn();
    const onOpenChange = vi.fn();
    render(<SettingsModal open onOpenChange={onOpenChange} onSaved={onSaved} />);

    await screen.findByLabelText("API key");
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("does not invoke onSaved when the save fails", async () => {
    mockedRest.putSettings.mockRejectedValue(new Error("boom"));
    const onSaved = vi.fn();
    render(<SettingsModal open onOpenChange={() => {}} onSaved={onSaved} />);

    await screen.findByLabelText("API key");
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await screen.findByText(/boom/i);
    expect(onSaved).not.toHaveBeenCalled();
  });
});
