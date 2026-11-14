"use client"

import { Textarea } from "./textarea"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip"
import { cn } from "../../lib/utils"
import React, {
  createContext,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
} from "react"

const PromptInputContext = createContext({
  isLoading: false,
  value: "",
  setValue: () => {},
  maxHeight: 240,
  onSubmit: undefined,
  disabled: false,
  textareaRef: React.createRef(),
})

function usePromptInput() {
  return useContext(PromptInputContext)
}

function PromptInput({
  className,
  isLoading = false,
  maxHeight = 240,
  value,
  onValueChange,
  onSubmit,
  children,
  disabled = false,
  onClick,
  ...props
}) {
  const [internalValue, setInternalValue] = useState(value || "")
  const textareaRef = useRef(null)

  const handleChange = (newValue) => {
    setInternalValue(newValue)
    onValueChange?.(newValue)
  }

  const handleClick = (e) => {
    if (!disabled) textareaRef.current?.focus()
    onClick?.(e)
  }

  return (
    <TooltipProvider>
      <PromptInputContext.Provider
        value={{
          isLoading,
          value: value ?? internalValue,
          setValue: onValueChange ?? handleChange,
          maxHeight,
          onSubmit,
          disabled,
          textareaRef,
        }}
      >
        <div
          onClick={handleClick}
          className={cn(
            "border-[#565869] bg-[#40414f] relative cursor-text rounded-3xl border p-2 shadow-sm",
            disabled && "cursor-not-allowed opacity-60",
            className
          )}
          {...props}
        >
          {children}
        </div>
      </PromptInputContext.Provider>
    </TooltipProvider>
  )
}

function PromptInputTextarea({
  className,
  onKeyDown,
  disableAutosize = false,
  ...props
}) {
  const { value, setValue, maxHeight, onSubmit, disabled, textareaRef } =
    usePromptInput()

  const adjustHeight = (el) => {
    if (!el || disableAutosize) return
    el.style.height = "auto"
    if (typeof maxHeight === "number") {
      el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
    } else {
      el.style.height = `min(${el.scrollHeight}px, ${maxHeight})`
    }
  }

  const handleRef = (el) => {
    textareaRef.current = el
    adjustHeight(el)
  }

  useLayoutEffect(() => {
    if (!textareaRef.current || disableAutosize) return
    const el = textareaRef.current
    el.style.height = "auto"
    if (typeof maxHeight === "number") {
      el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`
    } else {
      el.style.height = `min(${el.scrollHeight}px, ${maxHeight})`
    }
  }, [value, maxHeight, disableAutosize])

  const handleChange = (e) => {
    adjustHeight(e.target)
    setValue(e.target.value)
  }

  const handleKeyDown = (e) => {
    // Enter while an IME is composing confirms the text, it doesn't send.
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault()
      onSubmit?.()
    }
    onKeyDown?.(e)
  }

  return (
    <Textarea
      ref={handleRef}
      value={value}
      onChange={handleChange}
      onKeyDown={handleKeyDown}
      className={cn(
        "text-white min-h-[44px] w-full resize-none border-none bg-transparent shadow-none outline-none focus-visible:ring-0 focus-visible:ring-offset-0",
        className
      )}
      rows={1}
      disabled={disabled}
      {...props}
    />
  )
}

function PromptInputActions({ children, className, ...props }) {
  return (
    <div className={cn("flex items-center gap-2", className)} {...props}>
      {children}
    </div>
  )
}

function PromptInputAction({ tooltip, children, className, side = "top", ...props }) {
  const { disabled } = usePromptInput()

  return (
    <Tooltip {...props}>
      <TooltipTrigger
        asChild
        disabled={disabled}
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side={side} className={className}>
        {tooltip}
      </TooltipContent>
    </Tooltip>
  )
}

export {
  PromptInput,
  PromptInputTextarea,
  PromptInputActions,
  PromptInputAction,
}
